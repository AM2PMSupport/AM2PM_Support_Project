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
 */
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { callbacks, contacts, leads, processes } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { notify, supervisorsOf } from "@/lib/notifications";
import { publishOutboxSafely, writeOutbox } from "@/lib/events/outbox";
import { platformDb } from "@/lib/platform-admin/db";
import { contextForTenantId } from "@/lib/platform-admin/tenants";

const BATCH = 500;

export async function runCallbackReminders(now = new Date()) {
  const db = platformDb();
  const soon = new Date(now.getTime() + 15 * 60_000);
  const late = new Date(now.getTime() - 30 * 60_000);

  const dueSoon = await db
    .select({ id: callbacks.id, tenantId: callbacks.tenantId, leadId: callbacks.leadId, assignedTo: callbacks.assignedTo, dueAt: callbacks.dueAt, name: contacts.name })
    .from(callbacks)
    .innerJoin(leads, eq(leads.id, callbacks.leadId))
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .where(and(eq(callbacks.status, "pending"), isNull(callbacks.remindedAt), lte(callbacks.dueAt, soon), gt(callbacks.dueAt, late)))
    .limit(BATCH);

  const overdue = await db
    .select({ id: callbacks.id, tenantId: callbacks.tenantId, leadId: callbacks.leadId, assignedTo: callbacks.assignedTo, processId: leads.processId, name: contacts.name })
    .from(callbacks)
    .innerJoin(leads, eq(leads.id, callbacks.leadId))
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .where(and(eq(callbacks.status, "pending"), lte(callbacks.dueAt, late)))
    .limit(BATCH);

  for (const c of dueSoon) {
    const { ctx } = await contextForTenantId(c.tenantId);
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
  }

  for (const c of overdue) {
    const { ctx } = await contextForTenantId(c.tenantId);
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
  }

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
        sql`${leads.createdAt} < now() - make_interval(mins => coalesce((${processes.assignment}->>'slaMinutes')::int, 15))`,
      ),
    )
    .limit(BATCH);
  for (const w of waiting) {
    const { ctx } = await contextForTenantId(w.tenantId);
    await withTenant(ctx, async (tx) =>
      notify(tx, await supervisorsOf(tx, w.processId), {
        kind: "sla_breach",
        title: `Unassigned lead waiting in ${w.processName}`,
        body: "No eligible agent — check who is available",
        link: "/leads",
        dedupeKey: `sla:${w.leadId}`,
      }),
    );
  }

  return { reminded: dueSoon.length, missed: overdue.length, slaAlerts: waiting.length };
}
