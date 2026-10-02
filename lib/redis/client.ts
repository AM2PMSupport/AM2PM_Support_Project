/**
 * Upstash Redis (HTTP) client and key names.
 *
 * Redis holds only state that can be rebuilt (RULE.md §3.7): call locks,
 * presence, eligible-agent caches, rate limits, the CallerDesk caller-leg
 * cache. It is never the only copy of a record.
 *
 * Keys are built by the functions below so every key includes the tenant and
 * the naming stays consistent.
 */
import { Redis } from "@upstash/redis";
import { redisEnv } from "@/lib/config/env";

let client: Redis | undefined;

export function redis(): Redis {
  if (!client) {
    const env = redisEnv();
    client = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  }
  return client;
}

export const keys = {
  /** Held while an agent has a live call; blocks a second click-to-call. */
  callActive: (tenantId: string, userId: string) => `t:${tenantId}:call:active:${userId}`,
  callsSync: (tenantId: string) => `t:${tenantId}:calls:last_sync`,
  /** Agent presence: available | on_call | wrap_up | offline. */
  presence: (tenantId: string, userId: string) => `t:${tenantId}:presence:${userId}`,
  /** Cached eligible agents for a process (30 s). */
  eligible: (tenantId: string, processId: string) => `t:${tenantId}:eligible:${processId}`,
  /** CallerDesk leg-switch cache: session → real caller number. */
  callerLeg: (tenantId: string, session: string) => `t:${tenantId}:callerleg:${session}`,
  /** Fixed-window rate limit counter. */
  rate: (tenantId: string, bucket: string, window: number) => `t:${tenantId}:rate:${bucket}:${window}`,
};
