/**
 * Rate limits (SECURITY.md §2) — Redis fixed 1-minute windows → 429.
 *
 *   per person      PERSON_RATE_PER_MIN: every browser request that does work —
 *                   server actions (console, leads, Setup, Calls) AND /api/v1 /
 *                   GraphQL from the session — share ONE bucket, so a script
 *                   can't get around the API cap through the UI's actions
 *   per API key / per workspace   lib/api/context.ts
 *   sign-in         app/api/auth/login/route.ts (5 failures / email, 300 / IP)
 *   webhooks        badWebhookKey*: an IP sending wrong keys is blocked for
 *                   15 min — public URLs can't be used to guess secrets or
 *                   hammer the database
 *
 * Redis down → requests pass (fail open): a cache outage mustn't take the app down.
 */
import { ApiError } from "@/lib/http/errors";
import { sha256Hex } from "@/lib/crypto";
import { redis } from "@/lib/redis/client";
import type { TenantContext } from "@/lib/tenancy/context";

export const PERSON_RATE_PER_MIN = 300;
const BAD_WEBHOOK_KEYS_PER_IP = 30;
const BAD_WEBHOOK_WINDOW_S = 15 * 60;

/** Counts one request in a 1-minute window; throws 429 over `max`. */
export async function rateLimit(key: string, max: number, what: string): Promise<void> {
  const bucket = `${key}:${Math.floor(Date.now() / 60_000)}`;
  const n = await redis().incr(bucket).catch(() => 0);
  if (n === 1) await redis().expire(bucket, 70).catch(() => undefined);
  if (n > max) throw new ApiError(429, "rate_limited", `Too many requests: the limit is ${max} per minute ${what}. Wait a moment and try again.`);
}

/** One unit of work by a signed-in person (server action or session API call). */
export function limitPerson(ctx: Pick<TenantContext, "tenantId"> & { actor: { userId: string } }): Promise<void> {
  return rateLimit(`t:${ctx.tenantId}:rl:user:${ctx.actor.userId}`, PERSON_RATE_PER_MIN, "per person");
}

/** The caller's IP (Vercel sets x-forwarded-for; first entry is the client). Hashed before use as a key. */
export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";
}

const badKey = (req: Request) => `rl:webhook-bad:${sha256Hex(clientIp(req))}`;

/** Before verifying a webhook: 429 if this IP has sent too many wrong keys lately. */
export async function assertWebhookIpAllowed(req: Request): Promise<void> {
  const n = await redis().get<number>(badKey(req)).catch(() => 0);
  if ((n ?? 0) >= BAD_WEBHOOK_KEYS_PER_IP) throw new ApiError(429, "rate_limited", "Too many requests with a wrong key. Try again later.");
}

/** After a webhook failed verification: count it against the IP. */
export async function countBadWebhookKey(req: Request): Promise<void> {
  const key = badKey(req);
  const n = await redis().incr(key).catch(() => 0);
  if (n === 1) await redis().expire(key, BAD_WEBHOOK_WINDOW_S).catch(() => undefined);
}
