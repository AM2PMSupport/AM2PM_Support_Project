/**
 * Job name → handler. /api/jobs/[job] verifies the QStash signature and
 * then calls the handler here with the parsed payload.
 *
 * Every handler is idempotent (RULE.md §3.3) and short (< ~60 s); long work
 * fans out into more jobs instead of running in one invocation.
 */
import { assignLead } from "@/lib/assignment/assign";
import { deliverWebhook } from "@/lib/events/deliver";
import { processWebhook } from "@/lib/jobs/process-webhook";
import { contextForTenantId } from "@/lib/platform-admin/tenants";
import { purgeExpired, recountOpenLeads, relayOutbox, sweepStuckCalls, sweepUnassigned } from "@/lib/platform-admin/sweeps";
import type { JobName, JobPayloads } from "@/lib/queue/jobs";
import { log } from "@/lib/log";

type Handlers = { [J in JobName]: (payload: JobPayloads[J]) => Promise<void> };

export const handlers: Handlers = {
  "process-webhook": async ({ tenantId, webhookEventId }) => {
    const { ctx } = await contextForTenantId(tenantId);
    await processWebhook(ctx, webhookEventId);
  },

  "assign-lead": async ({ tenantId, leadId }) => {
    const { ctx } = await contextForTenantId(tenantId);
    const res = await assignLead(ctx, leadId);
    log.info("assign-lead", { tenant: ctx.tenantSlug, outcome: res.outcome });
  },

  "deliver-webhook": async ({ tenantId, outboxId, subscriptionId }) => {
    const { ctx } = await contextForTenantId(tenantId);
    await deliverWebhook(ctx, outboxId, subscriptionId);
  },

  "relay-outbox": async () => {
    await relayOutbox();
  },

  "sweep-unassigned": async () => {
    await sweepUnassigned();
  },

  "sweep-stuck-calls": async () => {
    await sweepStuckCalls();
  },

  "purge-expired": async () => {
    log.info("purge-expired", await purgeExpired());
  },

  "recount-open-leads": async () => {
    await recountOpenLeads();
  },

  "copy-recording": async ({ tenantId, interactionId }) => {
    // TODO(T1.39): stream interactions.recording_url into Blob/R2 at
    // recordings/{tenantSlug}/{yyyy}/{mm}/{interactionId}.mp3, set
    // interactions.recording_key, and never expose the provider URL.
    log.warn("copy-recording not implemented yet", { tenantId, interactionId });
  },
};
