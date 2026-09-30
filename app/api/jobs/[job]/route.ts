/**
 * POST /api/jobs/{job} — QStash calls this to run a background job.
 *
 * 1. Verify the QStash signature (nobody else may trigger jobs).
 * 2. Look up the handler by name (lib/jobs/handlers.ts).
 * 3. Run it. A thrown error returns 500 so QStash retries with backoff and,
 *    after the last retry, moves the message to the dead-letter queue.
 */
import { handlers } from "@/lib/jobs/handlers";
import { isJobName } from "@/lib/queue/jobs";
import { verifyQStash } from "@/lib/queue/qstash";
import { log } from "@/lib/log";

// Jobs must finish well inside this; long work fans out into more jobs.
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ job: string }> }): Promise<Response> {
  const { job } = await params;
  const rawBody = await req.text();

  try {
    await verifyQStash(req, rawBody);
  } catch {
    return Response.json({ error: { code: "unauthorized", message: "Bad signature" } }, { status: 401 });
  }
  if (!isJobName(job)) {
    // 200 so QStash does not retry a job name that will never exist.
    log.error("unknown job", { job });
    return Response.json({ ok: false, error: "unknown job" }, { status: 200 });
  }

  try {
    const payload: unknown = rawBody ? JSON.parse(rawBody) : {};
    await (handlers[job] as (p: unknown) => Promise<void>)(payload);
    return Response.json({ ok: true });
  } catch (err) {
    log.error("job failed", { job, err });
    return Response.json({ ok: false }, { status: 500 });
  }
}
