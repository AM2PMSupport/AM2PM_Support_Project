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
 *   per signed-in person   PERSON_RATE_PER_MIN, shared with the UI's server actions (lib/http/rate-limit.ts)
 * Redis down → requests pass (fail open): a cache outage mustn't take the API down.
 */
import { requireSession, type SessionContext } from "@/lib/auth/session";
import { lookupApiKey } from "@/lib/platform-admin/api-keys";
import { ApiError, forbidden, unauthorized } from "@/lib/http/errors";
import { limitPerson, rateLimit as limit } from "@/lib/http/rate-limit";
import { grantsFor } from "@/lib/auth/grants";


export const RATE_PER_MIN = 600;
export const TENANT_RATE_PER_MIN = 1200;

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
    await limitPerson(session);
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
