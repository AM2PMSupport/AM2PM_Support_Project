/**
 * Platform-wide sweeps run by Vercel Cron (ARCHITECTURE.md §4).
 *
 * They scan ACROSS tenants, which is why they live in platform-admin (the
 * only module allowed to bypass row-level security). Each sweep only finds
 * work and hands it to per-tenant code or jobs, except for purely technical
 * updates (stuck-call status, retention purge).
 */
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { interactions, outbox, webhookEvents } from "@/lib/db/schema";
import { publishOutbox } from "@/lib/events/outbox";
import { enqueue } from "@/lib/queue/qstash";
import { releaseCallLock } from "@/lib/telephony/lock";
import { platformDb } from "@/lib/platform-admin/db";
import { contextForTenantId } from "@/lib/platform-admin/tenants";
import { assignLead } from "@/lib/assignment/assign";
import { processWebhook } from "@/lib/jobs/process-webhook";
import { queueDegraded } from "@/lib/queue/health";
import { log } from "@/lib/log";

const BATCH = 500;
/** Per-client share of a sweep batch, so one client's backlog can't starve the others. */
const PER_TENANT = 25;
/** Rows deleted per statement in the nightly purge (short transactions, resumable). */
const PURGE_CHUNK = 5000;
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

/**
 * Leads still unassigned (e.g. arrived at night, or no agent was free):
 * try again INLINE, oldest first, within a time budget.
 *
 * Not one QStash message per lead: leads that can never be assigned (a
 * process with no mapped agents) were re-queued every run and used up the
 * free plan's 1,000 messages/day by mid-morning, which then stopped every
 * schedule and webhook (2026-10-03, MEMORIE.md). Assignment is DB-only, so
 * doing it here costs no messages; whatever the budget leaves is picked up
 * by the next run.
 */
export async function sweepUnassigned(budgetMs = 20_000): Promise<{ tried: number; assigned: number }> {
  const started = Date.now();
  // Oldest PER_TENANT unassigned leads of EACH client (window over the
  // leads_unassigned partial index), oldest first overall. A client with
  // thousands of unassignable leads (no agents mapped) gets its 25 tries and
  // can't push everyone else's leads out of the batch.
  const result = await platformDb().execute(sql`
    select id, tenant_id as "tenantId" from (
      select l.id, l.tenant_id, l.created_at,
             row_number() over (partition by l.tenant_id order by l.created_at) as rn
      from leads l
      where l.assigned_to is null and l.status = 'open' and l.is_active
    ) x
    where rn <= ${PER_TENANT}
    order by created_at
    limit ${BATCH}`);
  const rows = result.rows as { id: string; tenantId: string }[];
  const ctxs = new Map<string, Awaited<ReturnType<typeof contextForTenantId>>["ctx"]>();
  let tried = 0;
  let assigned = 0;
  for (const l of rows) {
    if (Date.now() - started > budgetMs) break;
    let ctx = ctxs.get(l.tenantId);
    if (!ctx) ctxs.set(l.tenantId, (ctx = (await contextForTenantId(l.tenantId)).ctx));
    tried++;
    try {
      if ((await assignLead(ctx, l.id)).outcome === "assigned") assigned++;
    } catch (err) {
      log.error("sweep-unassigned: lead failed", { tenant: ctx.tenantSlug, err }); // next run retries
    }
  }
  // TODO(T1.31): alert supervisors for leads waiting longer than the process slaMinutes.
  return { tried, assigned };
}

/**
 * Webhooks stored but never queued: QStash refused the publish (quota, outage)
 * and the provider's retry then looked like a duplicate, so nothing would ever
 * process them. Re-queue those still "received" after 2 minutes (last 2 days).
 *
 * Safety net (lib/queue/health.ts): while the queue is degraded — or as soon
 * as a re-queue fails — they are PROCESSED HERE, inline, until `deadline`,
 * so calls and leads keep flowing without QStash.
 */
export async function requeueStuckWebhooks(deadline = Date.now() + 40_000): Promise<number> {
  const stuck = await platformDb()
    .select({ id: webhookEvents.id, tenantId: webhookEvents.tenantId })
    .from(webhookEvents)
    // Served by the webhook_events_received partial index (only unprocessed rows).
    .where(
      and(
        eq(webhookEvents.status, "received"),
        lt(webhookEvents.createdAt, new Date(Date.now() - 2 * 60_000)),
        gt(webhookEvents.createdAt, new Date(Date.now() - 2 * DAY_MS)),
      ),
    )
    .orderBy(asc(webhookEvents.createdAt))
    .limit(500);
  const bucket = Math.floor(Date.now() / (15 * 60_000)); // one retry per sweep
  let inline = await queueDegraded();
  let handled = 0;
  for (const w of stuck) {
    if (Date.now() > deadline) break;
    if (!inline) {
      try {
        await enqueue("process-webhook", { tenantId: w.tenantId, webhookEventId: w.id }, { deduplicationId: `wh-requeue:${w.id}:${bucket}` });
        handled++;
        continue;
      } catch {
        inline = true; // queue just refused: process this one and the rest right here
      }
    }
    try {
      const { ctx } = await contextForTenantId(w.tenantId);
      await processWebhook(ctx, w.id);
      handled++;
    } catch (err) {
      log.error("inline webhook processing failed; next sweep retries", { tenantId: w.tenantId, err });
    }
  }
  if (handled) log.warn(inline ? "processed stuck webhooks inline (queue degraded)" : "re-queued webhooks that were never processed", { count: handled });
  return handled;
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
 *
 * In chunks of PURGE_CHUNK until done or the budget runs out: one unbounded
 * DELETE over 300 clients' daily volume (or after a missed night) could pass
 * 60 s, roll back and never finish. Whatever is left goes next night.
 */
export async function purgeExpired(now = Date.now(), budgetMs = 45_000): Promise<Record<string, number>> {
  const db = platformDb();
  const started = Date.now();
  const chunked = async (table: string, column: string, cutoff: Date, extra = sql``) => {
    let total = 0;
    while (Date.now() - started < budgetMs) {
      const r = await db.execute(sql`
        delete from ${sql.identifier(table)} where id in (
          select id from ${sql.identifier(table)} where ${sql.identifier(column)} < ${cutoff} ${extra} limit ${PURGE_CHUNK})`);
      const n = r.rowCount ?? 0;
      total += n;
      if (n < PURGE_CHUNK) break;
    }
    return total;
  };
  return {
    webhookEvents: await chunked("webhook_events", "created_at", new Date(now - 60 * DAY_MS)),
    outbox: await chunked("outbox", "published_at", new Date(now - 30 * DAY_MS), sql`and published_at is not null`),
    webhookDeliveries: await chunked("webhook_deliveries", "created_at", new Date(now - 90 * DAY_MS)),
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
