/**
 * Callback reminders and escalation (T1.36) + unassigned-lead SLA alerts
 * (T1.31). Runs every 5 minutes from a QStash schedule.
 *
 *   due within 15 min, not yet reminded → notify the owner, mark reminded
 *   overdue by 30+ min, still pending   → mark missed, notify owner and the
 *                                          process's supervisors/managers,
 *                                          emit callback.missed
 *   lead unassigned longer than the process SLA → notify supervisors once
 *
 * Scans across tenants (platform-admin), then acts per tenant inside
 * withTenant so notifications and events stay tenant-scoped. Idempotent via
 * notification dedupe keys and status guards.
 *
 * Scale (200–300 clients, code review 2026-10-05): each scan takes at most
 * PER_TENANT rows per client (one client's backlog can't starve the rest),
 * every row is handled in its own try/catch (one bad row no longer stops all
 * reminders), work stops at `deadline` and resumes next tick, and an SLA
 * alert is sent once per lead (`leads.sla_alerted_at`) instead of re-scanning
 * the same oldest leads every run.
 */
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { callbacks, contacts, leads, processes } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { notify, supervisorsOf } from "@/lib/notifications";
import { publishOutboxSafely, writeOutbox } from "@/lib/events/outbox";
import { platformDb } from "@/lib/platform-admin/db";
import { contextForTenantId } from "@/lib/platform-admin/tenants";
import { capPerTenant } from "@/lib/jobs/fair";
import type { TenantContext } from "@/lib/tenancy/context";
import { log } from "@/lib/log";

/** Rows read per scan; the per-client cap below keeps them spread across clients. */
const BATCH = 2000;
const PER_TENANT = 50;

export async function runCallbackReminders(now = new Date(), deadline = Date.now() + 40_000) {
  const db = platformDb();
  const ctxs = new Map<string, TenantContext>();
  const ctxFor = async (tenantId: string) => {
    let ctx = ctxs.get(tenantId);
    if (!ctx) ctxs.set(tenantId, (ctx = (await contextForTenantId(tenantId)).ctx));
    return ctx;
  };
  let errors = 0;
  /** Runs `fn` for each row until the deadline; a failing row is logged and retried next tick. */
  const each = async <T extends { tenantId: string }>(label: string, rows: T[], fn: (row: T, ctx: TenantContext) => Promise<void>) => {
    let done = 0;
    for (const row of capPerTenant(rows, PER_TENANT)) {
      if (Date.now() > deadline) break;
      try {
        await fn(row, await ctxFor(row.tenantId));
        done++;
      } catch (err) {
        errors++;
        log.error(`callback-reminders: ${label} row failed`, { tenantId: row.tenantId, err });
      }
    }
    return done;
  };
  const soon = new Date(now.getTime() + 15 * 60_000);
  const late = new Date(now.getTime() - 30 * 60_000);

  const dueSoon = await db
    .select({ id: callbacks.id, tenantId: callbacks.tenantId, leadId: callbacks.leadId, assignedTo: callbacks.assignedTo, dueAt: callbacks.dueAt, name: contacts.name })
    .from(callbacks)
    .innerJoin(leads, eq(leads.id, callbacks.leadId))
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .where(and(eq(callbacks.status, "pending"), isNull(callbacks.remindedAt), lte(callbacks.dueAt, soon), gt(callbacks.dueAt, late)))
    .orderBy(asc(callbacks.dueAt))
    .limit(BATCH);

  const overdue = await db
    .select({ id: callbacks.id, tenantId: callbacks.tenantId, leadId: callbacks.leadId, assignedTo: callbacks.assignedTo, processId: leads.processId, name: contacts.name })
    .from(callbacks)
    .innerJoin(leads, eq(leads.id, callbacks.leadId))
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .where(and(eq(callbacks.status, "pending"), lte(callbacks.dueAt, late)))
    .orderBy(asc(callbacks.dueAt))
    .limit(BATCH);

  const reminded = await each("due", dueSoon, async (c, ctx) => {
    await withTenant(ctx, async (tx) => {
      if (c.assignedTo) {
        const mins = Math.max(0, Math.round((c.dueAt.getTime() - now.getTime()) / 60000));
        await notify(tx, [c.assignedTo], {
          kind: "callback_due",
          title: `Call back ${c.name ?? "a lead"} ${mins ? `in ${mins} min` : "now"}`,
          link: `/console?lead=${c.leadId}`,
          dedupeKey: `cb-due:${c.id}`,
        });
      }
      await tx.update(callbacks).set({ remindedAt: now }).where(eq(callbacks.id, c.id));
    });
  });

  const missed = await each("overdue", overdue, async (c, ctx) => {
    const ids = await withTenant(ctx, async (tx) => {
      const [moved] = await tx
        .update(callbacks)
        .set({ status: "missed" })
        .where(and(eq(callbacks.id, c.id), eq(callbacks.status, "pending")))
        .returning({ id: callbacks.id });
      if (!moved) return [];
      const bosses = await supervisorsOf(tx, c.processId);
      await notify(tx, [...(c.assignedTo ? [c.assignedTo] : []), ...bosses], {
        kind: "callback_missed",
        title: `Missed callback: ${c.name ?? "a lead"}`,
        body: "Overdue by more than 30 minutes",
        link: `/console?lead=${c.leadId}`,
        dedupeKey: `cb-missed:${c.id}`,
      });
      return [await writeOutbox(tx, "callback.missed", c.leadId, { leadId: c.leadId, processId: c.processId, callbackId: c.id, assignedTo: c.assignedTo })];
    });
    await publishOutboxSafely(ctx, ids);
  });

  // SLA: unassigned open leads waiting longer than their process allows.
  const waiting = await db
    .select({ leadId: leads.id, tenantId: leads.tenantId, processId: leads.processId, processName: processes.name, createdAt: leads.createdAt })
    .from(leads)
    .innerJoin(processes, eq(processes.id, leads.processId))
    .where(
      and(
        isNull(leads.assignedTo),
        eq(leads.status, "open"),
        eq(leads.isActive, true),
        isNull(leads.slaAlertedAt), // alerted once; already-alerted leads drop out of the scan
        sql`${leads.createdAt} < now() - make_interval(mins => coalesce((${processes.assignment}->>'slaMinutes')::int, 15))`,
      ),
    )
    .orderBy(asc(leads.createdAt))
    .limit(BATCH);
  const slaAlerts = await each("sla", waiting, async (w, ctx) => {
    await withTenant(ctx, async (tx) => {
      await notify(tx, await supervisorsOf(tx, w.processId), {
        kind: "sla_breach",
        title: `Unassigned lead waiting in ${w.processName}`,
        body: "No eligible agent — check who is available",
        link: "/leads",
        dedupeKey: `sla:${w.leadId}`,
      });
      await tx.update(leads).set({ slaAlertedAt: now }).where(eq(leads.id, w.leadId));
    });
  });

  return { reminded, missed, slaAlerts, errors };
}
