/**
 * Queue health — the automatic safety net for QStash (free quota used up,
 * paid plan lapsed, outage). Owner request 2026-10-05; ARCHITECTURE.md §4.
 *
 * Any failed publish marks the queue "degraded" in Redis for DEGRADED_S
 * (renewed while failures continue; cleared by the next successful publish).
 * While degraded, callers fall back instead of failing:
 *   webhooks      stored + 200 anyway; processed inline by the stuck-webhook sweep
 *   new leads     assigned inline (assignment is DB-only)
 *   call sync     QUEUE_FANOUT is ignored → clients synced inline in turn
 *   timer work    driven by page traffic (lib/queue/fallback-tick.ts) and the
 *                 daily Vercel Cron, both of which run jobs directly
 * The first failure also alerts every Super Admin (notification + banner).
 *
 * The flag is cached per instance for CACHE_MS so checking it costs ~nothing.
 */
import { keys, redis } from "@/lib/redis/client";
import { log } from "@/lib/log";

const DEGRADED_S = 30 * 60;
const CACHE_MS = 30_000;
let cached: { at: number; degraded: boolean } | null = null;

export interface QueueState {
  since: string;
  reason: string;
}

/** True while publishes are failing (cached 30 s per instance; Redis down → assume healthy). */
export async function queueDegraded(): Promise<boolean> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.degraded;
  const v = await redis().get(keys.queueDegraded()).catch(() => null);
  cached = { at: Date.now(), degraded: !!v };
  return cached.degraded;
}

export async function queueState(): Promise<QueueState | null> {
  const v = await redis().get<QueueState | string>(keys.queueDegraded()).catch(() => null);
  if (!v) return null;
  return typeof v === "string" ? (JSON.parse(v) as QueueState) : v;
}

/** Short, log-safe reason from a QStash error (quota / billing / auth / network). */
export function failureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/quota|limit|exceed|too many|429/i.test(msg)) return "QStash refused: message quota or rate limit reached";
  if (/billing|payment|plan|402|suspend/i.test(msg)) return "QStash refused: billing or plan problem";
  if (/unauthor|forbidden|401|403|token/i.test(msg)) return "QStash refused: token rejected";
  return "QStash unreachable";
}

/** Called by enqueue() on any publish error. Never throws. */
export async function markQueueFailure(err: unknown): Promise<void> {
  const state: QueueState = { since: new Date().toISOString(), reason: failureReason(err) };
  cached = { at: Date.now(), degraded: true };
  try {
    // NX first so only the FIRST failure of an episode alerts; then renew the expiry.
    const first = await redis().set(keys.queueDegraded(), JSON.stringify(state), { nx: true, ex: DEGRADED_S });
    if (!first) await redis().expire(keys.queueDegraded(), DEGRADED_S);
    if (first) {
      log.error("queue degraded — switching to fallback mode", { reason: state.reason });
      const { alertSuperAdmins } = await import("@/lib/platform-admin/queue-alert");
      await alertSuperAdmins(state);
    }
  } catch (e) {
    log.error("queue health: could not record failure", { err: e });
  }
}

/** Called by enqueue() after a successful publish: ends a degraded episode early. */
export async function markQueueOk(): Promise<void> {
  if (!cached?.degraded) return;
  cached = { at: Date.now(), degraded: false };
  await redis().del(keys.queueDegraded()).catch(() => undefined);
  log.info("queue healthy again — fallback mode off");
}

/** Test hook: forget the per-instance cache. */
export function resetQueueHealthCache(): void {
  cached = null;
}
