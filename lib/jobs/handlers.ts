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
import { purgeExpired, recountOpenLeads, relayOutbox, requeueStuckWebhooks, sweepStuckCalls, sweepUnassigned } from "@/lib/platform-admin/sweeps";
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
    log.info("sweep-unassigned", await sweepUnassigned());
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
    await syncAllCalls();
  },

  "copy-recording": async ({ tenantId, interactionId }) => {
    const { ctx } = await contextForTenantId(tenantId);
    const r = await copyRecording(ctx, interactionId);
    log.info("copy-recording", { tenant: ctx.tenantSlug, result: r });
  },

  // Runs at :00, :05, … The 15-minute work goes with the ticks at :00/:15/:30/:45.
  // Parts run side by side and fail independently; a failed part is retried by
  // the next tick, so the tick itself always succeeds (no QStash retry storm).
  tick: async () => {
    const quarter = new Date().getUTCMinutes() % 15 < 5;
    const parts: [string, () => Promise<unknown>][] = [["callback-reminders", runCallbackReminders]];
    if (quarter) {
      parts.push(
        ["relay-outbox", relayOutbox],
        ["sweep-stuck-calls", sweepStuckCalls],
        ["sweep-unassigned", () => sweepUnassigned()],
        ["requeue-webhooks", requeueStuckWebhooks],
        ["sync-calls", syncAllCalls],
      );
    }
    const results = await Promise.allSettled(parts.map(([, run]) => run()));
    results.forEach((r, i) => {
      if (r.status === "rejected") log.error(`tick: ${parts[i]![0]} failed`, { err: r.reason });
    });
    log.info("tick", Object.fromEntries(results.map((r, i) => [parts[i]![0], r.status === "fulfilled" ? (r.value ?? "ok") : "failed"])));
  },
};

/** Pull every tenant's provider call report; one tenant failing can't block the rest. */
async function syncAllCalls() {
  for (const t of await tenantsWithTelephony()) {
    const { ctx } = await contextForTenantId(t);
    try {
      const r = await syncCalls(ctx);
      log.info("sync-calls", { tenant: ctx.tenantSlug, rows: r?.rows ?? 0, failed: r?.failed ?? 0 });
    } catch (err) {
      log.error("sync-calls failed", { tenant: ctx.tenantSlug, err }); // next run retries
    }
  }
}
