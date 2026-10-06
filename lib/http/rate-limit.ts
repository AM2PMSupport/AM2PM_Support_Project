/**
 * Rate limits (SECURITY.md §2) — Redis fixed 1-minute windows → 429.
 *
 *   per person      PERSON_RATE_PER_MIN: every browser request that does work —
 *                   server actions (console, leads, Setup, Calls) AND /api/v1 /
 *                   GraphQL from the session — share ONE bucket, so a script
 *                   can't get around the API cap through the UI's actions
 *   per API key / per workspace   lib/api/context.ts
 *   sign-in         app/api/auth/login/route.ts (5 failures / email, 300 / IP)
 *   webhooks        an IP probing UNKNOWN workspaces / sources is blocked for
 *                   15 min. A wrong key for a KNOWN workspace never blocks:
 *                   providers (CallerDesk) send every workspace's webhooks from
 *                   the same IPs, so blocking by IP let one workspace's stale
 *                   key refuse all workspaces (2026-10-06 incident). Those are
 *                   counted per workspace instead (Setup → Telephony shows them);
 *                   the keys are 24+ random bytes, so guessing isn't a risk
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

const probeKey = (req: Request) => `rl:webhook-probe:${sha256Hex(clientIp(req))}`;

/** Before any lookup: 429 if this IP has been probing unknown workspaces / sources. */
export async function assertWebhookIpAllowed(req: Request): Promise<void> {
  const n = await redis().get<number>(probeKey(req)).catch(() => 0);
  if ((n ?? 0) >= BAD_WEBHOOK_KEYS_PER_IP) throw new ApiError(429, "rate_limited", "Too many requests for unknown endpoints. Try again later.");
}

/** A webhook for a workspace / source that doesn't exist: counts against the IP. */
export async function countWebhookProbe(req: Request): Promise<void> {
  const key = probeKey(req);
  const n = await redis().incr(key).catch(() => 0);
  if (n === 1) await redis().expire(key, BAD_WEBHOOK_WINDOW_S).catch(() => undefined);
}

/** A wrong key for a real workspace: counted for that workspace today (shown in Setup), never blocks. */
export async function countRejectedWebhook(tenantId: string, source: string): Promise<void> {
  const key = `t:${tenantId}:hooks-rejected:${source}:${new Date().toISOString().slice(0, 10)}`;
  const n = await redis().incr(key).catch(() => 0);
  if (n === 1) await redis().expire(key, 3 * 86_400).catch(() => undefined);
  await redis().set(`t:${tenantId}:hooks-rejected:${source}:last`, new Date().toISOString(), { ex: 3 * 86_400 }).catch(() => undefined);
}

/** Today's rejected count + last time, for Setup. */
export async function rejectedWebhooks(tenantId: string, source: string): Promise<{ today: number; lastAt: string | null }> {
  try {
    const r = redis();
    const [n, last] = await Promise.all([
      r.get<number>(`t:${tenantId}:hooks-rejected:${source}:${new Date().toISOString().slice(0, 10)}`),
      r.get<string>(`t:${tenantId}:hooks-rejected:${source}:last`),
    ]);
    return { today: Number(n ?? 0), lastAt: last ?? null };
  } catch {
    return { today: 0, lastAt: null }; // Redis down / not configured: Setup still loads
  }
}
