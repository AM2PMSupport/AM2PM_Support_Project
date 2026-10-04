/**
 * Setup → Roles & permissions: a Super Admin edits this workspace's matrix
 * (DESIGN.md §7). Each save is one cell (role × area → actions). Cells equal to
 * the default are deleted, so role_permissions only ever holds real edits and
 * future default changes still reach unedited cells. Super Admin's own grants
 * are locked (no lock-out). Tenant-isolated by RLS; every change is audited.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { rolePermissions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { defaultGrants, LOCKED_ROLES, MODULES, normalizeActions, ROLES } from "@/lib/auth/rbac";
import { primeWorkspaceEdits } from "@/lib/auth/grants";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { badRequest, forbidden } from "@/lib/http/errors";

export const PermissionInput = z.object({
  role: z.enum(ROLES as [string, ...string[]]),
  module: z.enum(MODULES),
  // Letters from VCEDAXI only; order and duplicates are normalised.
  actions: z.string().max(14).regex(/^[VCEDAXI]*$/, "Use only the letters V C E D A X I"),
});

/** Sets one cell; `actions: ""` = no access, `reset: true` = back to the default. */
export async function setRolePermission(ctx: SessionContext, raw: z.input<typeof PermissionInput>, reset = false): Promise<{ actions: string }> {
  // "Super Admin only" is a fixed rule, not a matrix cell — otherwise an edit could grant itself.
  if (ctx.actor.role !== "super_admin") throw forbidden("Only a Super Admin can change permissions");
  const input = PermissionInput.parse(raw);
  const role = input.role as (typeof ROLES)[number];
  if (LOCKED_ROLES.includes(role)) throw badRequest("Super Admin permissions can't be changed");
  const fallback = defaultGrants(role)[input.module] ?? "";
  const actions = reset ? fallback : normalizeActions(input.actions);

  const edits = await withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ actions: rolePermissions.actions })
      .from(rolePermissions)
      .where(and(eq(rolePermissions.role, role), eq(rolePermissions.module, input.module)));
    if (actions === fallback) {
      await tx.delete(rolePermissions).where(and(eq(rolePermissions.role, role), eq(rolePermissions.module, input.module)));
    } else {
      await tx
        .insert(rolePermissions)
        .values({ role, module: input.module, actions, updatedBy: ctx.actor.userId })
        .onConflictDoUpdate({ target: [rolePermissions.tenantId, rolePermissions.role, rolePermissions.module], set: { actions, updatedBy: ctx.actor.userId, updatedAt: new Date() } });
    }
    await writeAudit(tx, ctx, {
      action: "role_permission.changed",
      entity: "role_permission",
      before: { role, module: input.module, actions: before?.actions ?? fallback },
      after: { role, module: input.module, actions },
    });
    return tx.select({ role: rolePermissions.role, module: rolePermissions.module, actions: rolePermissions.actions }).from(rolePermissions);
  });
  // This instance serves the new matrix at once; others within the 30 s cache (lib/auth/grants.ts).
  primeWorkspaceEdits(ctx.tenantId, edits);
  return { actions };
}
