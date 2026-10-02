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
import { runCallbackReminders } from "@/lib/platform-admin/reminders";
import { runImportChunk } from "@/lib/imports/run";
import { copyRecording } from "@/lib/telephony/recordings";
import { syncCalls } from "@/lib/telephony/sync";
import { tenantsWithTelephony } from "@/lib/platform-admin/tenants";
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

  "import-batch": async ({ tenantId, batchId, offset }) => {
    const { ctx } = await contextForTenantId(tenantId);
    const res = await runImportChunk(ctx, batchId, offset);
    log.info("import-batch", { tenant: ctx.tenantSlug, batchId, offset, done: res.done });
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

  "callback-reminders": async () => {
    log.info("callback-reminders", await runCallbackReminders());
  },

  "sync-calls": async () => {
    for (const t of await tenantsWithTelephony()) {
      const { ctx } = await contextForTenantId(t);
      try {
        const r = await syncCalls(ctx);
        log.info("sync-calls", { tenant: ctx.tenantSlug, rows: r?.rows ?? 0, failed: r?.failed ?? 0 });
      } catch (err) {
        log.error("sync-calls failed", { tenant: ctx.tenantSlug, err }); // next run retries; one tenant can't block the rest
      }
    }
  },

  "copy-recording": async ({ tenantId, interactionId }) => {
    const { ctx } = await contextForTenantId(tenantId);
    const r = await copyRecording(ctx, interactionId);
    log.info("copy-recording", { tenant: ctx.tenantSlug, result: r });
  },
};
