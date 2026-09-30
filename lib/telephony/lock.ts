/**
 * One live call per agent (RULE.md §6.1.5).
 *
 * `SET key NX EX 900` succeeds only if the agent has no active call. The
 * lock is released on a terminal call webhook, on an API failure, or — if
 * webhooks never arrive — by expiry (15 min) and the stuck-call sweeper.
 * The value is the interaction id, so only the owning call can release it.
 */
import { keys, redis } from "@/lib/redis/client";

const LOCK_TTL_SECONDS = 15 * 60;

export async function acquireCallLock(tenantId: string, userId: string, interactionId: string): Promise<boolean> {
  const res = await redis().set(keys.callActive(tenantId, userId), interactionId, { nx: true, ex: LOCK_TTL_SECONDS });
  return res === "OK";
}

/** Releases only if the lock still belongs to this interaction. */
export async function releaseCallLock(tenantId: string, userId: string, interactionId: string): Promise<void> {
  const key = keys.callActive(tenantId, userId);
  const holder = await redis().get<string>(key);
  if (holder === interactionId) await redis().del(key);
}

export async function activeCallId(tenantId: string, userId: string): Promise<string | null> {
  return redis().get<string>(keys.callActive(tenantId, userId));
}
