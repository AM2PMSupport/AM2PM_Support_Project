/**
 * Audit log + sign-in activity for the signed-in workspace (Setup →
 * Security). audit_logs is append-only for the app role (no UPDATE/DELETE,
 * 0001_rls.sql) and tenant-isolated by RLS. Keyset paging on (created_at, id).
 */
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { auditLogs, users } from "@/lib/db/schema";
import { withTenantRead } from "@/lib/db/tenant";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";

export async function listAudit(ctx: SessionContext, cursor?: string, limit = 50) {
  requirePermission(ctx, "audit", "V");
  const [cAt, cId] = (cursor ?? "").split("|");
  const after = cAt && cId ? or(lt(auditLogs.createdAt, new Date(cAt)), and(eq(auditLogs.createdAt, new Date(cAt)), lt(auditLogs.id, cId))) : undefined;
  const rows = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: auditLogs.id, action: auditLogs.action, entity: auditLogs.entity, after: auditLogs.after, at: auditLogs.createdAt, who: users.name })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(after)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({ ...r, at: r.at.toISOString(), after: r.after ? JSON.stringify(r.after).slice(0, 160) : null })),
    nextCursor: rows.length > limit && last ? `${last.at.toISOString()}|${last.id}` : null,
  };
}

/** Last sign-in per person in this workspace (Zoho's "Login History", lite). */
export async function loginActivity(ctx: SessionContext) {
  requirePermission(ctx, "audit", "V");
  return withTenantRead(ctx, (tx) =>
    tx
      .select({ name: users.name, email: users.email, role: users.role, status: users.status, lastLoginAt: users.lastLoginAt })
      .from(users)
      .orderBy(sql`${users.lastLoginAt} desc nulls last`, users.name)
      .limit(200),
  ).then((r) => r.map((u) => ({ ...u, lastLoginAt: u.lastLoginAt?.toISOString() ?? null })));
}

