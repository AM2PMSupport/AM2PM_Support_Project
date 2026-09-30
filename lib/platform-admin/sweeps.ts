/**
 * Platform-wide sweeps run by Vercel Cron (ARCHITECTURE.md §4).
 *
 * They scan ACROSS tenants, which is why they live in platform-admin (the
 * only module allowed to bypass row-level security). Each sweep only finds
 * work and hands it to per-tenant code or jobs, except for purely technical
 * updates (stuck-call status, retention purge).
 */
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { interactions, leads, outbox, webhookDeliveries, webhookEvents } from "@/lib/db/schema";
import { publishOutbox } from "@/lib/events/outbox";
import { enqueue } from "@/lib/queue/qstash";
import { releaseCallLock } from "@/lib/telephony/lock";
import { platformDb } from "@/lib/platform-admin/db";
import { contextForTenantId } from "@/lib/platform-admin/tenants";
import { log } from "@/lib/log";

const BATCH = 500;
const DAY_MS = 86_400_000;

/** Outbox rows not published within a minute of commit (function died mid-way). */
export async function relayOutbox(): Promise<number> {
  const stale = await platformDb()
    .select({ id: outbox.id, tenantId: outbox.tenantId })
    .from(outbox)
    .where(and(isNull(outbox.publishedAt), lt(outbox.createdAt, new Date(Date.now() - 60_000))))
    .limit(BATCH);

  const byTenant = new Map<string, string[]>();
  for (const r of stale) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r.id]);
  for (const [tenantId, ids] of byTenant) {
    const { ctx } = await contextForTenantId(tenantId);
    await publishOutbox(ctx, ids);
  }
  return stale.length;
}

/** Leads still unassigned (e.g. arrived at night): queue another attempt. */
export async function sweepUnassigned(): Promise<number> {
  const rows = await platformDb()
    .select({ id: leads.id, tenantId: leads.tenantId })
    .from(leads)
    .where(and(isNull(leads.assignedTo), eq(leads.status, "open"), eq(leads.isActive, true)))
    .limit(BATCH);
  // 5-minute buckets in the dedupe id so each sweep can retry the same lead once.
  const bucket = Math.floor(Date.now() / 300_000);
  for (const l of rows) {
    await enqueue("assign-lead", { tenantId: l.tenantId, leadId: l.id }, { deduplicationId: `assign:${l.id}:${bucket}` });
  }
  // TODO(T1.31): alert supervisors for leads waiting longer than the process slaMinutes.
  return rows.length;
}

/** Click-to-calls with no webhook for 10 minutes → "unknown"; free the agent. */
export async function sweepStuckCalls(): Promise<number> {
  const stuck = await platformDb()
    .update(interactions)
    .set({ status: "unknown", endedAt: new Date(), endReason: "no_webhook" })
    .where(and(eq(interactions.status, "initiated"), lt(interactions.startedAt, new Date(Date.now() - 10 * 60_000))))
    .returning({ tenantId: interactions.tenantId, agentId: interactions.agentId, correlationId: interactions.correlationId, id: interactions.id });

  for (const c of stuck) {
    if (c.agentId) await releaseCallLock(c.tenantId, c.agentId, c.correlationId ?? c.id);
  }
  if (stuck.length) log.warn("stuck calls marked unknown — check provider webhooks", { count: stuck.length });
  return stuck.length;
}

/**
 * Retention (Postgres has no TTL indexes): delete raw webhooks after 60 days,
 * published outbox rows after 30, delivery logs after 90 (ARCHITECTURE.md §6).
 */
export async function purgeExpired(now = Date.now()): Promise<Record<string, number>> {
  const db = platformDb();
  const count = (r: { rowCount?: number | null }) => r.rowCount ?? 0;
  return {
    webhookEvents: count(await db.delete(webhookEvents).where(lt(webhookEvents.createdAt, new Date(now - 60 * DAY_MS)))),
    outbox: count(
      await db.delete(outbox).where(and(isNotNull(outbox.publishedAt), lt(outbox.publishedAt, new Date(now - 30 * DAY_MS)))),
    ),
    webhookDeliveries: count(await db.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, new Date(now - 90 * DAY_MS)))),
  };
}

/** Nightly: recompute users.open_leads from leads to fix any drift (RULE.md §4.4). */
export async function recountOpenLeads(): Promise<void> {
  await platformDb().execute(sql`
    update users u set open_leads = coalesce(c.n, 0)
    from (select u2.id, count(l.id)::int as n
          from users u2 left join leads l on l.assigned_to = u2.id and l.status = 'open'
          group by u2.id) c
    where c.id = u.id and u.open_leads is distinct from coalesce(c.n, 0)`);
}
