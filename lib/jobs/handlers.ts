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
import { syncAttendanceIfStale } from "@/lib/platform-admin/attendance";
import { runDigests } from "@/lib/platform-admin/digest";
import { runBackups } from "@/lib/platform-admin/backups";
import { runImportChunk } from "@/lib/imports/run";
import { copyRecording } from "@/lib/telephony/recordings";
import { syncCalls } from "@/lib/telephony/sync";
import { tenantsWithTelephony } from "@/lib/platform-admin/tenants";
import type { JobName, JobPayloads } from "@/lib/queue/jobs";
import { enqueue } from "@/lib/queue/qstash";
import { keys, redis } from "@/lib/redis/client";
import { rotate } from "@/lib/jobs/fair";
import { queueDegraded } from "@/lib/queue/health";
import { log } from "@/lib/log";

/**
 * Every part of a tick stops starting new work at this point, so the 60 s
 * function (app/api/jobs/[job] maxDuration) always returns 200. A killed tick
 * would be retried by QStash up to 5 times, repeating reminders and sweeps and
 * spending messages (code review 2026-10-05).
 */
const TICK_BUDGET_MS = 45_000;

/**
 * QUEUE_FANOUT=1 (paid QStash): one queued job per client for call sync, so
 * 300 clients sync in parallel. Off (free plan, 1,000 messages/day): clients
 * are synced inline, in turn, within the tick's budget — no extra messages.
 */
const fanout = () => process.env.QUEUE_FANOUT === "1";

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
    await syncAllCalls(Date.now() + TICK_BUDGET_MS);
  },

  "sync-calls-tenant": async ({ tenantId }) => {
    const { ctx } = await contextForTenantId(tenantId);
    const r = await syncCalls(ctx, undefined, { deadline: Date.now() + TICK_BUDGET_MS });
    log.info("sync-calls", { tenant: ctx.tenantSlug, rows: r?.rows ?? 0, skipped: r?.skipped ?? 0, failed: r?.failed ?? 0, partial: r?.partial ?? false });
  },

  "copy-recording": async ({ tenantId, interactionId }) => {
    const { ctx } = await contextForTenantId(tenantId);
    const r = await copyRecording(ctx, interactionId);
    log.info("copy-recording", { tenant: ctx.tenantSlug, result: r });
  },

  // Runs at :00, :05, … The 15-minute work goes with the ticks at :00/:15/:30/:45.
  // Parts run side by side and fail independently; a failed part is retried by
  // the next tick, so the tick itself always succeeds (no QStash retry storm).
  backups: async () => {
    log.info("backups", { result: await runBackups(Date.now() + TICK_BUDGET_MS) });
  },

  tick: async () => {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const quarter = new Date().getUTCMinutes() % 15 < 5;
    const parts: [string, () => Promise<unknown>][] = [
      ["callback-reminders", () => runCallbackReminders(new Date(), deadline)],
      // Jibble has no webhooks: poll clock events (people + leave on their own slower clocks).
      ["attendance", syncAttendanceIfStale],
      // 09:00 manager digest per workspace timezone, once a day (T1.42).
      ["digest", () => runDigests(deadline)],
      // Continues snapshots the nightly cron couldn't finish within its 60 s (T1.43).
      ["backups", () => runBackups(deadline)],
    ];
    if (quarter) {
      parts.push(
        ["relay-outbox", relayOutbox],
        ["sweep-stuck-calls", sweepStuckCalls],
        ["sweep-unassigned", () => sweepUnassigned(20_000)],
        ["requeue-webhooks", () => requeueStuckWebhooks(deadline)],
      );
    }
    // Inline mode syncs every tick (clients in turn, continuing where the last tick stopped);
    // fan-out mode queues one job per client every 15 min. A degraded queue (quota used
    // up, plan lapsed) also means: stuck webhooks are processed every tick, inline.
    const degraded = await queueDegraded();
    if (!fanout() || degraded || quarter) parts.push(["sync-calls", () => syncAllCalls(deadline)]);
    if (degraded && !quarter) parts.push(["requeue-webhooks", () => requeueStuckWebhooks(deadline)]);
    const results = await Promise.allSettled(parts.map(([, run]) => run()));
    results.forEach((r, i) => {
      if (r.status === "rejected") log.error(`tick: ${parts[i]![0]} failed`, { err: r.reason });
    });
    log.info("tick", Object.fromEntries(results.map((r, i) => [parts[i]![0], r.status === "fulfilled" ? (r.value ?? "ok") : "failed"])));
  },
};

/**
 * Every client's provider call report. Fan-out: one job per client (deduped
 * per 15-min window). Inline: clients in turn from where the last run stopped,
 * until the deadline; one client failing can't block the rest.
 */
async function syncAllCalls(deadline: number): Promise<{ synced: number; of: number; queued?: number }> {
  const all = await tenantsWithTelephony();
  // Fan-out only while the queue is healthy; if it refuses mid-way, the rest go inline.
  if (fanout() && !(await queueDegraded())) {
    const bucket = Math.floor(Date.now() / (15 * 60_000));
    let queued = 0;
    try {
      for (const t of all) {
        await enqueue("sync-calls-tenant", { tenantId: t }, { deduplicationId: `sync:${t}:${bucket}` });
        queued++;
      }
      return { synced: 0, of: all.length, queued };
    } catch {
      log.warn("sync fan-out refused by the queue; syncing inline", { queued, of: all.length });
    }
  }
  const cursor = await redis().get<string>(keys.callsSyncCursor()).catch(() => null);
  let synced = 0;
  for (const t of rotate(all, cursor)) {
    if (Date.now() > deadline) break;
    const { ctx } = await contextForTenantId(t);
    try {
      const r = await syncCalls(ctx, undefined, { deadline });
      log.info("sync-calls", { tenant: ctx.tenantSlug, rows: r?.rows ?? 0, skipped: r?.skipped ?? 0, failed: r?.failed ?? 0, partial: r?.partial ?? false });
      // A client cut off mid-report is NOT passed, so the next tick starts with it again.
      if (r?.partial) break;
    } catch (err) {
      log.error("sync-calls failed", { tenant: ctx.tenantSlug, err }); // next round retries
    }
    synced++;
    await redis().set(keys.callsSyncCursor(), t, { ex: 86_400 }).catch(() => undefined);
  }
  return { synced, of: all.length };
}
