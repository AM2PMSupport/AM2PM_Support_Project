/**
 * Platform-level tenant lookups. We must find the tenant BEFORE we can build
 * a TenantContext, so this reads the global `tenants` table directly
 * (allowed only in lib/platform-admin, RULE.md §1.4).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { integrations, tenants, type Tenant } from "@/lib/db/schema";
import { isUuid } from "@/lib/db/tenant";
import { platformDb } from "@/lib/platform-admin/db";
import { systemContext, type TenantContext } from "@/lib/tenancy/context";

export async function tenantBySlug(slug: string): Promise<Tenant | null> {
  // Slugs are lowercase letters, digits and dashes; anything else can't match.
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return null;
  const [t] = await platformDb()
    .select()
    .from(tenants)
    .where(and(eq(tenants.slug, slug), inArray(tenants.status, ["active", "trial"])))
    .limit(1);
  return t ?? null;
}

export async function tenantById(id: string): Promise<Tenant | null> {
  if (!isUuid(id)) return null;
  const [t] = await platformDb().select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return t ?? null;
}

/** Build a system context for a job payload's tenantId (published by us). */
export async function contextForTenantId(tenantId: string): Promise<{ ctx: TenantContext; tenant: Tenant }> {
  const tenant = await tenantById(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  return { ctx: systemContext(tenant), tenant };
}

/** Tenants with an active telephony integration and the scheduled call sync switched on (Setup → Telephony). */
export async function tenantsWithTelephony(): Promise<string[]> {
  const rows = await platformDb()
    .selectDistinct({ id: integrations.tenantId })
    .from(integrations)
    .innerJoin(tenants, eq(tenants.id, integrations.tenantId))
    .where(and(eq(integrations.kind, "telephony"), eq(integrations.status, "active"), inArray(tenants.status, ["active", "trial"]), sql`(${integrations.config}->>'syncCalls') is distinct from 'false'`));
  return rows.map((r) => r.id);
}
