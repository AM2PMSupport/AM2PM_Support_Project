/**
 * GET /api/cron/{job} — Vercel Cron entry points (schedules in vercel.json).
 *
 * Crons only FAN OUT (RULE.md §3.5): each one enqueues the matching QStash
 * job and returns. The work runs in /api/jobs/* with retries, so a slow
 * sweep never blocks the cron request and failures are retried.
 *
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}`; anything else is 401.
 */
import { securityEnv } from "@/lib/config/env";
import { safeEqualHex, sha256Hex } from "@/lib/crypto";
import { handle } from "@/lib/http/errors";
import { enqueue } from "@/lib/queue/qstash";
import type { JobName } from "@/lib/queue/jobs";

// Schedules are UTC in vercel.json: 20:30 UTC = 02:00 IST, 21:00 UTC = 02:30 IST.
const CRON_JOBS = new Set<JobName>(["relay-outbox", "sweep-unassigned", "sweep-stuck-calls", "purge-expired", "recount-open-leads"]);

export const GET = handle(async (req: Request, { params }: { params: Promise<{ job: string }> }): Promise<Response> => {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqualHex(sha256Hex(token), sha256Hex(securityEnv().CRON_SECRET))) {
    return Response.json({ error: { code: "unauthorized", message: "Bad cron secret" } }, { status: 401 });
  }

  const { job } = await params;
  if (!CRON_JOBS.has(job as JobName)) {
    return Response.json({ error: { code: "not_found", message: "Unknown cron job" } }, { status: 404 });
  }

  // One run per minute at most, even if Vercel retries the cron request.
  const minute = Math.floor(Date.now() / 60_000);
  const messageId = await enqueue(job as "relay-outbox", {}, { deduplicationId: `cron:${job}:${minute}` });
  return Response.json({ ok: true, messageId });
});
