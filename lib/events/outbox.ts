/**
 * Transactional outbox (ARCHITECTURE.md §3.6, RULE.md §2.3).
 *
 * Why: we must never lose an event (lead converted but webhook never sent)
 * and never send one for a change that rolled back. So:
 *
 *   1. `writeOutbox(tx, ...)` inserts the event IN THE SAME TRANSACTION as
 *      the business change.
 *   2. After commit, `publishOutbox(...)` fans the event out to every
 *      matching subscription via QStash and stamps `published_at`.
 *   3. A 1-minute cron (`relay-outbox`) publishes anything step 2 missed
 *      (e.g. the function was killed between commit and publish).
 *
 * Delivery is at-least-once; receivers dedupe on the stable event id.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { outbox, webhookSubscriptions, type OutboxEvent, type WebhookSubscription } from "@/lib/db/schema";
import { withTenant, type Tx } from "@/lib/db/tenant";
import type { EventType } from "@/lib/events/catalogue";
import { enqueue } from "@/lib/queue/qstash";
import type { TenantContext } from "@/lib/tenancy/context";
import { log } from "@/lib/log";

/** Call inside the transaction that makes the change. Returns the outbox id. */
export async function writeOutbox(tx: Tx, eventType: EventType, entityId: string, payload: Record<string, unknown>): Promise<string> {
  const [row] = await tx.insert(outbox).values({ eventType, entityId, payload }).returning({ id: outbox.id });
  return row!.id;
}

/** Does this subscription want this event? (event list + optional filters) */
export function subscriptionMatches(
  sub: Pick<WebhookSubscription, "events" | "filters">,
  ev: Pick<OutboxEvent, "eventType" | "payload">,
): boolean {
  if (!sub.events.includes(ev.eventType)) return false;
  const processId = typeof ev.payload.processId === "string" ? ev.payload.processId : undefined;
  if (sub.filters.processIds?.length && (!processId || !sub.filters.processIds.includes(processId))) return false;
  const stage = typeof ev.payload.stage === "string" ? ev.payload.stage : undefined;
  if (sub.filters.stages?.length && (!stage || !sub.filters.stages.includes(stage))) return false;
  return true;
}

/**
 * Publish specific outbox rows (call right after the transaction commits).
 * Safe to call twice: QStash dedupes on `${outboxId}:${subscriptionId}` and
 * `published_at` is set only once. HTTP calls happen OUTSIDE transactions.
 */
export async function publishOutbox(ctx: TenantContext, outboxIds: string[]): Promise<void> {
  if (!outboxIds.length) return;
  const { events, subs } = await withTenant(ctx, async (tx) => ({
    events: await tx.select().from(outbox).where(and(inArray(outbox.id, outboxIds), isNull(outbox.publishedAt))),
    subs: await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.isActive, true)),
  }));

  for (const ev of events) {
    for (const sub of subs.filter((s) => subscriptionMatches(s, ev))) {
      await enqueue(
        "deliver-webhook",
        { tenantId: ctx.tenantId, outboxId: ev.id, subscriptionId: sub.id },
        { deduplicationId: `${ev.id}:${sub.id}` },
      );
    }
    // Workflows (phase 2) will be triggered here as well, from the same event.
  }

  if (events.length) {
    await withTenant(ctx, (tx) =>
      tx
        .update(outbox)
        .set({ publishedAt: new Date() })
        .where(and(inArray(outbox.id, events.map((e) => e.id)), isNull(outbox.publishedAt))),
    );
  }
}

/** Fire-and-log wrapper: a failed publish is retried by the relay cron. */
export async function publishOutboxSafely(ctx: TenantContext, outboxIds: string[]): Promise<void> {
  try {
    await publishOutbox(ctx, outboxIds);
  } catch (err) {
    log.warn("outbox publish deferred to relay", { tenant: ctx.tenantSlug, err });
  }
}
