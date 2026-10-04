/**
 * Loads a workspace's edits to the role permission matrix (role_permissions)
 * and turns them into the actor's effective grants (lib/auth/rbac.ts
 * effectiveGrants). Called once per request by the session / API-key context
 * builders, so every permission check sees the workspace's Setup → Roles
 * edits (DESIGN.md §7).
 *
 * Cache: per instance, per workspace, 30 s. The edit action (lib/admin/roles.ts)
 * replaces this instance's entry with the freshly written rows, so the editor
 * sees the change at once; other instances pick it up within 30 s. Reads go to
 * a replica (RULE.md §7) — the 30 s window also covers replica lag.
 */
import { asc } from "drizzle-orm";
import { rolePermissions, type Role } from "@/lib/db/schema";
import { withTenantRead } from "@/lib/db/tenant";
import { effectiveGrants, LOCKED_ROLES, type Grants } from "@/lib/auth/rbac";
import type { TenantContext } from "@/lib/tenancy/context";

export type PermissionEdit = { role: string; module: string; actions: string };

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; edits: PermissionEdit[] }>();

export async function workspaceEdits(ctx: Pick<TenantContext, "tenantId" | "tenantSlug" | "timezone">): Promise<PermissionEdit[]> {
  const hit = cache.get(ctx.tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.edits;
  const edits = await withTenantRead({ tenantId: ctx.tenantId, tenantSlug: ctx.tenantSlug, timezone: ctx.timezone }, (tx) =>
    tx.select({ role: rolePermissions.role, module: rolePermissions.module, actions: rolePermissions.actions }).from(rolePermissions).orderBy(asc(rolePermissions.role)),
  );
  cache.set(ctx.tenantId, { at: Date.now(), edits });
  return edits;
}

/** After a Setup → Roles save: this instance serves the new matrix immediately. */
export function primeWorkspaceEdits(tenantId: string, edits: PermissionEdit[]): void {
  cache.set(tenantId, { at: Date.now(), edits });
}

/** The actor's effective grants in this workspace. Locked roles skip the query. */
export async function grantsFor(ctx: Pick<TenantContext, "tenantId" | "tenantSlug" | "timezone">, role: Role): Promise<Grants> {
  if (LOCKED_ROLES.includes(role)) return effectiveGrants(role, []);
  return effectiveGrants(role, await workspaceEdits(ctx));
}
