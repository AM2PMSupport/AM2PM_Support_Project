/**
 * Deliver one event to one subscriber (job: "deliver-webhook").
 *
 * - Signs the body (lib/events/signature.ts) and POSTs with a 10 s timeout.
 *   The HTTP call runs OUTSIDE any database transaction.
 * - Records every attempt in `webhook_deliveries` (last 6 kept).
 * - Non-2xx or network error → throw, so QStash retries with backoff
 *   (~1m, 5m, 30m, 2h, 12h). After the last retry the message lands in the
 *   QStash dead-letter queue, visible on the admin "Failed events" screen.
 * - A subscription failing for 24 h straight is auto-paused (DESIGN.md §6.2).
 */
import { and, eq } from "drizzle-orm";
import { outbox, webhookDeliveries, webhookSubscriptions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import type { EventEnvelope, EventType } from "@/lib/events/catalogue";
import { SIGNATURE_HEADER, signPayload } from "@/lib/events/signature";
import type { TenantContext } from "@/lib/tenancy/context";
import { log } from "@/lib/log";

const TIMEOUT_MS = 10_000;
const AUTO_PAUSE_AFTER_MS = 24 * 60 * 60 * 1000;
const KEEP_ATTEMPTS = 6;

export async function deliverWebhook(ctx: TenantContext, outboxId: string, subscriptionId: string): Promise<void> {
  const loaded = await withTenant(ctx, async (tx) => {
    const [ev] = await tx.select().from(outbox).where(eq(outbox.id, outboxId));
    const [sub] = await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId));
    return { ev, sub };
  });
  const { ev, sub } = loaded;
  if (!ev || !sub || !sub.isActive) return; // nothing to do; don't retry

  const envelope: EventEnvelope = {
    id: `evt_${ev.id}`,
    type: ev.eventType as EventType,
    tenant: ctx.tenantSlug,
    occurredAt: ev.createdAt.toISOString(),
    data: ev.payload,
  };
  const body = JSON.stringify(envelope);
  const started = Date.now();
  let code: number | undefined;
  let error: string | undefined;

  try {
    const res = await fetch(sub.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: signPayload(decrypt(sub.secretEnc), body),
        "User-Agent": "AM2PM-CRM-Webhooks/1",
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual", // never follow redirects to an unverified host
    });
    code = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const attempt = { at: new Date().toISOString(), responseCode: code, ms: Date.now() - started, error };
  const paused = await withTenant(ctx, async (tx) => {
    // Upsert the delivery row and append this attempt (row lock avoids lost updates).
    const [existing] = await tx
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.subscriptionId, sub.id), eq(webhookDeliveries.eventId, ev.id)))
      .for("update");
    const status = error ? ("failed" as const) : ("delivered" as const);
    if (existing) {
      await tx
        .update(webhookDeliveries)
        .set({ status, attempts: [...existing.attempts, attempt].slice(-KEEP_ATTEMPTS) })
        .where(eq(webhookDeliveries.id, existing.id));
    } else {
      await tx.insert(webhookDeliveries).values({ subscriptionId: sub.id, eventId: ev.id, eventType: ev.eventType, status, attempts: [attempt] });
    }

    if (!error) {
      if (sub.failingSince) await tx.update(webhookSubscriptions).set({ failingSince: null }).where(eq(webhookSubscriptions.id, sub.id));
      return false;
    }
    const failingSince = sub.failingSince ?? new Date();
    const pause = Date.now() - failingSince.getTime() > AUTO_PAUSE_AFTER_MS;
    await tx
      .update(webhookSubscriptions)
      .set({ failingSince, ...(pause ? { isActive: false } : {}) })
      .where(eq(webhookSubscriptions.id, sub.id));
    return pause;
  });

  if (!error) return;
  if (paused) {
    // TODO(T2.10): email tenant admins that the subscription was paused.
    log.warn("webhook subscription auto-paused", { tenant: ctx.tenantSlug, subscriptionId });
    return;
  }
  throw new Error(`webhook delivery failed: ${error}`); // → QStash retry
}
