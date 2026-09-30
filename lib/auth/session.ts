/**
 * Session → TenantContext for API routes used by people.
 *
 * Auth.js (Google + email OTP, optional TOTP) is wired in TASK.md T1.11.
 * Until then `requireSession` refuses every request, so no route can be used
 * without real authentication. Do NOT replace this with a header or query
 * parameter shortcut: tenantId must come from a verified session (RULE.md §1.7).
 */
import { unauthorized } from "@/lib/http/errors";
import type { TenantContext } from "@/lib/tenancy/context";

export interface SessionContext extends TenantContext {
  actor: NonNullable<TenantContext["actor"]>;
}

export async function requireSession(_req: Request): Promise<SessionContext> {
  // TODO(T1.11): read the Auth.js session, load the user and tenant, and
  // return { tenantId, tenantSlug, dbName, actor: { userId, role, name } }.
  throw unauthorized("Sign-in is not configured yet (TASK.md T1.11).", "auth_not_configured");
}
