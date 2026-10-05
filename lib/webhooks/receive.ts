/**
 * Inbound webhook intake — the ONLY thing webhook routes do (RULE.md §3.1):
 *
 *   verify → insert into webhook_events (idempotent) → enqueue → 200
 *
 * No business logic runs here, so a burst of provider calls cannot slow the
 * API or lose data: everything is persisted first and processed by the
 * "process-webhook" job with retries and a dead-letter queue.
 *
 * Exception, call webhooks (`processNow`, 2026-10-05, RULE.md §3.1): the
 * agent's live call stepper waits on them, so they are processed right AFTER
 * the 200 (next/server `after`) — no QStash hop, no wait when the free quota
 * is used up. Still stored first; on failure the job is queued for retries. This replaces
 * crmv7's doPost, which held a 25-second script lock per request.
 */
import { webhookEvents } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { sha256Hex } from "@/lib/crypto";
import { after } from "next/server";
import { enqueue } from "@/lib/queue/qstash";
import { processWebhook } from "@/lib/jobs/process-webhook";
import type { TenantContext } from "@/lib/tenancy/context";
import { log } from "@/lib/log";


export interface ReceiveInput {
  ctx: TenantContext;
  /** e.g. "source:<importSourceId>" or "telephony:callerdesk". */
  source: string;
  payload: Record<string, unknown>;
  rawBody: string;
  /** Provider's own event id when it sends one; else we hash the body. */
  providerEventId?: string;
  /** Process right after the response instead of via QStash (call state). */
  processNow?: boolean;
}

export async function receiveWebhook(input: ReceiveInput): Promise<{ duplicate: boolean }> {
  const { ctx, source, payload, rawBody, providerEventId, processNow } = input;
  const idempotencyKey = providerEventId ?? sha256Hex(rawBody);

  // ON CONFLICT DO NOTHING: a provider retry of the same event returns no row.
  const [row] = await withTenant(ctx, (tx) =>
    tx.insert(webhookEvents).values({ source, idempotencyKey, payload }).onConflictDoNothing().returning({ id: webhookEvents.id }),
  );
  if (!row) return { duplicate: true };

  if (processNow) {
    const run = () =>
      processWebhook(ctx, row.id).catch(() =>
        // Failed (row marked "failed", visible in Failed events): let QStash retry it.
        enqueue("process-webhook", { tenantId: ctx.tenantId, webhookEventId: row.id }, { deduplicationId: `wh:${row.id}` }).catch((err) =>
          log.warn("call webhook failed and could not be queued; Replay it from Failed events", { tenant: ctx.tenantSlug, source, err }),
        ),
      );
    try {
      after(run);
    } catch {
      await run(); // outside a request (tests, scripts)
    }
    return { duplicate: false };
  }

  try {
    await enqueue("process-webhook", { tenantId: ctx.tenantId, webhookEventId: row.id }, { deduplicationId: `wh:${row.id}` });
  } catch (err) {
    // Queue refused (quota / billing / outage): the event is SAVED, so answer 200 —
    // a 500 would make the provider retry, and its retry would look like a duplicate.
    // The stuck-webhook sweep processes it (inline while the queue is degraded).
    log.warn("webhook stored but not queued; the sweep will process it", { tenant: ctx.tenantSlug, source, err });
  }
  return { duplicate: false };
}

/**
 * Parse a webhook body: JSON first, then form-encoded (CallerDesk may send
 * either, as crmv7's doPost handled), then query parameters as a fallback.
 */
export function parseWebhookBody(req: Request, rawBody: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (rawBody) {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(out, parsed);
    } catch {
      for (const [k, v] of new URLSearchParams(rawBody)) out[k] = v;
    }
  }
  for (const [k, v] of new URL(req.url).searchParams) {
    if (k === "key") {
      // GET providers sometimes append "?a=1&b=2" to a URL that already has
      // "?key=…", giving key="SECRET?a=1" — recover those params too.
      const q = v.indexOf("?");
      if (q >= 0) for (const [k2, v2] of new URLSearchParams(v.slice(q + 1))) if (out[k2] === undefined) out[k2] = v2;
      continue; // never store the secret key
    }
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}
