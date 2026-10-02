/**
 * Workspaces (tenants) — Super Admin only (T1.12). `tenants` is global, so
 * this lives in platform-admin. Every change is audit-logged in the acting
 * Super Admin's own tenant.
 */
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { tenants, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { forbidden, conflict } from "@/lib/http/errors";
import { writeAudit } from "@/lib/audit";
import type { SessionContext } from "@/lib/auth/session";
import { platformDb } from "@/lib/platform-admin/db";

function requireSuperAdmin(ctx: SessionContext) {
  if (ctx.actor.role !== "super_admin") throw forbidden("Only a Super Admin can manage workspaces");
}

export const WorkspaceInput = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "lowercase letters, digits and dashes"),
  timezone: z.string().trim().default("Asia/Kolkata"),
  status: z.enum(["active", "trial", "suspended", "closed"]).default("active"),
});

export async function listWorkspaces(ctx: SessionContext) {
  requireSuperAdmin(ctx);
  const db = platformDb();
  const rows = await db.select().from(tenants).orderBy(asc(tenants.name));
  const counts = await db.select({ tenantId: users.tenantId, n: sql<number>`count(*)::int` }).from(users).groupBy(users.tenantId);
  return rows.map((t) => ({ ...t, users: counts.find((c) => c.tenantId === t.id)?.n ?? 0 }));
}

export async function createWorkspace(ctx: SessionContext, input: z.infer<typeof WorkspaceInput>) {
  requireSuperAdmin(ctx);
  try {
    Intl.DateTimeFormat("en-IN", { timeZone: input.timezone });
  } catch {
    throw conflict("Unknown timezone", "bad_timezone");
  }
  const [t] = await platformDb().insert(tenants).values(input).onConflictDoNothing().returning();
  if (!t) throw conflict("That workspace URL name is taken");
  await withTenant(ctx, (tx) => writeAudit(tx, ctx, { action: "workspace.created", entity: "tenant", entityId: t.id, after: { slug: t.slug } }));
  return t;
}

export async function setWorkspaceStatus(ctx: SessionContext, id: string, status: "active" | "trial" | "suspended" | "closed") {
  requireSuperAdmin(ctx);
  if (id === ctx.tenantId && status !== "active") throw conflict("You can't suspend your own workspace");
  await platformDb().update(tenants).set({ status }).where(eq(tenants.id, id));
  await withTenant(ctx, (tx) => writeAudit(tx, ctx, { action: `workspace.${status}`, entity: "tenant", entityId: id }));
}

/**
 * Company settings written from inside a workspace (lib/admin/company.ts).
 * The caller passes ITS OWN session tenant id; permission is checked there.
 */
export async function updateWorkspaceSettings(tenantId: string, input: { name: string; timezone: string; currency: string }) {
  await platformDb().update(tenants).set({ name: input.name, timezone: input.timezone, currency: input.currency, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
}
