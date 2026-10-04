/**
 * The tenant context that every data access carries (RULE.md §1).
 *
 * `tenantId` must come from a trusted place only:
 *   - the signed-in session (API routes used by people), or
 *   - the tenant slug in a verified webhook URL (provider callbacks), or
 *   - a QStash job payload that the CRM itself published.
 * Never from a request body a user controls.
 */
import type { Role } from "@/lib/db/schema";
import type { Grants } from "@/lib/auth/rbac";

export interface TenantContext {
  /** Tenant UUID; becomes `app.tenant_id` inside withTenant(). */
  tenantId: string;
  /** Tenant slug, for URLs and logs. */
  tenantSlug: string;
  /** IANA timezone for working hours, day boundaries and display. */
  timezone: string;
  /**
   * Who is acting. Absent for system jobs and provider webhooks. `grants` =
   * the role's permissions in THIS workspace (defaults + Setup → Roles edits),
   * loaded by lib/auth/grants.ts; absent → defaults (tests, system code).
   */
  actor?: { userId: string; role: Role; name: string; grants?: Grants };
}

/** Context for background work that the system does on a tenant's behalf. */
export function systemContext(tenant: { id: string; slug: string; timezone: string }): TenantContext {
  return { tenantId: tenant.id, tenantSlug: tenant.slug, timezone: tenant.timezone };
}
