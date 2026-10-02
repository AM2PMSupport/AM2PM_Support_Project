/**
 * Company settings for the signed-in workspace (T1.12): display name,
 * timezone (drives working hours, "today" on the Floor, reminders) and
 * currency. The RLS role can read its own `tenants` row but not change it
 * (0001_rls.sql), so the write goes through platform-admin with the tenant
 * id from the SESSION — never from the form. Audited.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tenants } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { updateWorkspaceSettings } from "@/lib/platform-admin/workspaces";

const ZONES = new Set(Intl.supportedValuesOf("timeZone"));

export const CompanyInput = z.object({
  name: z.string().trim().min(2).max(80),
  timezone: z.string().refine((z) => ZONES.has(z) || z === "UTC", "Unknown timezone"),
  currency: z.enum(["INR", "USD", "AED", "GBP", "EUR", "SGD"]),
});

export async function getCompany(ctx: SessionContext) {
  requirePermission(ctx, "config", "V");
  const [t] = await withTenant(ctx, (tx) => tx.select({ name: tenants.name, slug: tenants.slug, timezone: tenants.timezone, currency: tenants.currency, status: tenants.status, createdAt: tenants.createdAt }).from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return { ...t!, createdAt: t!.createdAt.toISOString() };
}

export async function updateCompany(ctx: SessionContext, raw: z.input<typeof CompanyInput>) {
  requirePermission(ctx, "config", "E");
  const input = CompanyInput.parse(raw); // validated here too, not only in the action
  const before = await getCompany(ctx);
  await updateWorkspaceSettings(ctx.tenantId, input);
  await withTenant(ctx, (tx) => writeAudit(tx, ctx, { action: "workspace.settings_updated", entity: "tenant", entityId: ctx.tenantId, before: { name: before.name, timezone: before.timezone, currency: before.currency }, after: input }));
}

export const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];
