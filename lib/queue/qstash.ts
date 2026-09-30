/**
 * QStash: at-least-once job delivery with retries and a dead-letter queue.
 *
 * `enqueue(job, payload)` publishes to `${APP_URL}/api/jobs/${job}`. QStash
 * calls that URL back, signing the request; `verifyQStash` checks the
 * signature so nobody else can trigger jobs (RULE.md §3.4).
 *
 * Handlers MUST be idempotent: QStash may deliver twice, and each retry is
 * billed as a message (RULE.md §3.3).
 */
import { Client, Receiver } from "@upstash/qstash";
import { appEnv, qstashEnv } from "@/lib/config/env";
import type { JobName, JobPayloads } from "@/lib/queue/jobs";

let client: Client | undefined;
let receiver: Receiver | undefined;

function qstash(): Client {
  return (client ??= new Client({ token: qstashEnv().QSTASH_TOKEN }));
}

export interface EnqueueOptions {
  /** Seconds to wait before first delivery (e.g. callback reminders). */
  delaySeconds?: number;
  /** QStash drops a second publish with the same id (10-min window). */
  deduplicationId?: string;
  /** Default 5 retries with QStash's exponential backoff. */
  retries?: number;
}

export async function enqueue<J extends JobName>(job: J, payload: JobPayloads[J], opts: EnqueueOptions = {}) {
  const res = await qstash().publishJSON({
    url: `${appEnv().APP_URL}/api/jobs/${job}`,
    body: payload,
    retries: opts.retries ?? 5,
    delay: opts.delaySeconds,
    deduplicationId: opts.deduplicationId,
  });
  return res.messageId;
}

/** Throws if the request did not come from QStash. Pass the RAW body text. */
export async function verifyQStash(req: Request, rawBody: string): Promise<void> {
  const env = qstashEnv();
  receiver ??= new Receiver({
    currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
  });
  const signature = req.headers.get("upstash-signature");
  if (!signature) throw new Error("missing upstash-signature");
  const ok = await receiver.verify({ signature, body: rawBody, url: req.url });
  if (!ok) throw new Error("bad QStash signature");
}
