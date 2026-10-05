/**
 * GET /api/cron/{job} — Vercel Cron entry points (schedules in vercel.json).
 *
 * Crons run the job DIRECTLY (RULE.md §3.5, changed 2026-10-05): they used
 * to enqueue it on QStash, which made the daily backup useless exactly when
 * QStash was out of quota or down. Every job is idempotent and time-boxed.
 *
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}`; anything else is 401.
 */
import { securityEnv } from "@/lib/config/env";
import { safeEqualHex, sha256Hex } from "@/lib/crypto";
import { handle } from "@/lib/http/errors";
import type { JobName } from "@/lib/queue/jobs";
import { handlers } from "@/lib/jobs/handlers";
import { log } from "@/lib/log";

// Runs the job in THIS request (no QStash): the daily crons are the backup that
// keeps working when the queue is out of quota or the plan has lapsed
// (lib/queue/health.ts), and they no longer spend queue messages.
export const maxDuration = 60;

// Schedules are UTC in vercel.json: 20:30 UTC = 02:00 IST, 21:00 UTC = 02:30 IST.
const CRON_JOBS = new Set<JobName>(["relay-outbox", "sweep-unassigned", "sweep-stuck-calls", "purge-expired", "recount-open-leads", "callback-reminders", "tick"]);

export const GET = handle(async (req: Request, { params }: { params: Promise<{ job: string }> }): Promise<Response> => {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqualHex(sha256Hex(token), sha256Hex(securityEnv().CRON_SECRET))) {
    return Response.json({ error: { code: "unauthorized", message: "Bad cron secret" } }, { status: 401 });
  }

  const { job } = await params;
  if (!CRON_JOBS.has(job as JobName)) {
    return Response.json({ error: { code: "not_found", message: "Unknown cron job" } }, { status: 404 });
  }

  // Every job here is idempotent, so a Vercel retry of the cron request is harmless.
  const started = Date.now();
  await (handlers[job as JobName] as (p: Record<string, never>) => Promise<void>)({});
  log.info("cron job ran inline", { job, ms: Date.now() - started });
  return Response.json({ ok: true, ms: Date.now() - started });
});
