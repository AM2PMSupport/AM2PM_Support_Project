/**
 * Who is calling the REST / GraphQL API.
 *
 *   Authorization: Bearer am2pm_…  → API key (acts as its creator; scope read|write)
 *   otherwise                      → the signed-in browser session (full scope)
 *
 * tenantId always comes from the key record or the signed session, never
 * from the request (RULE.md §1.7). Rate limits (Redis fixed 1-minute
 * windows → 429 rate_limited):
 *   per API key            RATE_PER_MIN
 *   per client (all keys)  TENANT_RATE_PER_MIN — extra keys can't multiply it,
 *                          so one client's script can't starve the others
 *   per signed-in person   SESSION_RATE_PER_MIN (browser use of /api/v1, GraphQL)
 * Redis down → requests pass (fail open): a cache outage mustn't take the API down.
 */
import { requireSession, type SessionContext } from "@/lib/auth/session";
import { lookupApiKey } from "@/lib/platform-admin/api-keys";
import { ApiError, forbidden, unauthorized } from "@/lib/http/errors";
import { redis } from "@/lib/redis/client";
import { grantsFor } from "@/lib/auth/grants";


export const RATE_PER_MIN = 600;
export const TENANT_RATE_PER_MIN = 1200;
export const SESSION_RATE_PER_MIN = 300;

/** Counts one request in a 1-minute window; throws 429 over `limit`. */
async function limit(key: string, max: number, what: string): Promise<void> {
  const bucket = `${key}:${Math.floor(Date.now() / 60_000)}`;
  const n = await redis().incr(bucket).catch(() => 0);
  if (n === 1) await redis().expire(bucket, 70).catch(() => undefined);
  if (n > max) throw new ApiError(429, "rate_limited", `Rate limit is ${max} requests per minute ${what}`);
}

export interface ApiContext extends SessionContext {
  via: "session" | "api_key";
  scope: "read" | "write";
}

export async function apiContext(req: Request): Promise<ApiContext> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(am2pm_[A-Za-z0-9_-]{20,})$/i.exec(auth.trim())?.[1];
  if (!bearer) {
    if (auth) throw unauthorized("Invalid API key", "invalid_api_key");
    const session = await requireSession(req);
    await limit(`t:${session.tenantId}:rl:user:${session.actor.userId}`, SESSION_RATE_PER_MIN, "per person");
    return { ...session, via: "session", scope: "write" };
  }
  const k = await lookupApiKey(bearer);
  if (!k) throw unauthorized("Invalid or revoked API key", "invalid_api_key");

  await limit(`t:${k.tenantId}:rl:key:${k.keyId}`, RATE_PER_MIN, "per key");
  await limit(`t:${k.tenantId}:rl:tenant`, TENANT_RATE_PER_MIN, "per workspace (all keys together)");

  return {
    tenantId: k.tenantId,
    tenantSlug: k.tenantSlug,
    tenantName: k.tenantName,
    timezone: k.timezone,
    accountId: "",
    // Same workspace permission edits as a signed-in person (Setup → Roles).
    actor: { userId: k.userId, role: k.role, name: `${k.name} (API)`, grants: await grantsFor({ tenantId: k.tenantId, tenantSlug: k.tenantSlug, timezone: k.timezone }, k.role) },
    via: "api_key",
    scope: k.scope,
  };
}

/** Writes need a "write" key (sessions always may; RBAC still applies after this). */
export function requireWrite(ctx: ApiContext): void {
  if (ctx.scope !== "write") throw forbidden("This API key is read-only", "read_only_key");
}
