/**
 * Job catalogue: every background job name and the shape of its payload.
 *
 * Adding a job = add it here, add a handler in lib/jobs/handlers.ts. The
 * route /api/jobs/[job] validates the name against this list, so a typo can
 * never reach a handler. Payloads carry UUIDs only (never PII) because QStash
 * stores them.
 */
export interface JobPayloads {
  /** Process one stored inbound webhook (lead source or telephony). */
  "process-webhook": { tenantId: string; webhookEventId: string };
  /** Assign one lead to an eligible agent. */
  "assign-lead": { tenantId: string; leadId: string };
  /** Publish unpublished outbox rows (safety net after commit-time publish). */
  "relay-outbox": Record<string, never>;
  /** Deliver one outbox event to one subscription (HMAC-signed POST). */
  "deliver-webhook": { tenantId: string; outboxId: string; subscriptionId: string };
  /** Retry assignment for leads still unassigned (every 5 min). */
  "sweep-unassigned": Record<string, never>;
  /** Mark click-to-calls with no webhook for 10 min as "unknown"; free locks. */
  "sweep-stuck-calls": Record<string, never>;
  /** Delete expired webhook_events / outbox / delivery rows (Postgres has no TTL). */
  "purge-expired": Record<string, never>;
  /** Recompute users.open_leads from leads to fix drift. */
  "recount-open-leads": Record<string, never>;
  /** Copy a provider recording URL into Blob/R2. */
  "copy-recording": { tenantId: string; interactionId: string };
}

export type JobName = keyof JobPayloads;

export const JOB_NAMES = [
  "process-webhook",
  "assign-lead",
  "relay-outbox",
  "deliver-webhook",
  "sweep-unassigned",
  "sweep-stuck-calls",
  "purge-expired",
  "recount-open-leads",
  "copy-recording",
] as const satisfies readonly JobName[];

export function isJobName(v: string): v is JobName {
  return (JOB_NAMES as readonly string[]).includes(v);
}
