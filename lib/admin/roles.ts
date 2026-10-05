/**
 * Setup → Roles & permissions: a Super Admin edits this workspace's matrix
 * (DESIGN.md §7). The screen edits a draft; Save sends every changed cell
 * (role × area → actions) in one transaction, so a save applies whole or not
 * at all. Cells equal to the default are deleted, so role_permissions only
 * ever holds real edits and future default changes still reach unedited
 * cells. Module-access switches (`screen.<name>`) are cells too; switching one
 * on also grants View on the area it needs (SCREEN_NEEDS), so the module
 * works. Super Admin's own grants are locked (no lock-out). Tenant-isolated
 * by RLS; every changed cell is audited.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { rolePermissions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { defaultGrants, effectiveGrants, GRANT_KEYS, LOCKED_ROLES, normalizeActions, ROLES, SCREEN_NEEDS, type Screen } from "@/lib/auth/rbac";
import { primeWorkspaceEdits } from "@/lib/auth/grants";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { badRequest, forbidden } from "@/lib/http/errors";

export const PermissionInput = z.object({
  role: z.enum(ROLES as [string, ...string[]]),
  // A matrix area, or `screen.<name>` for module access ("V" on, "" off).
  module: z.enum(GRANT_KEYS as [string, ...string[]]),
  // Letters from VCEDAXI only; order and duplicates are normalised.
  actions: z.string().max(14).regex(/^[VCEDAXI]*$/, "Use only the letters V C E D A X I"),
});

/** Saves a batch of cells in one transaction; `actions: ""` = no access. Returns the saved values. */
export async function setRolePermissions(ctx: SessionContext, raw: unknown): Promise<{ role: string; module: string; actions: string }[]> {
  // "Super Admin only" is a fixed rule, not a matrix cell — otherwise an edit could grant itself.
  if (ctx.actor.role !== "super_admin") throw forbidden("Only a Super Admin can change permissions");
  const cells = z.array(PermissionInput).max(ROLES.length * GRANT_KEYS.length).parse(raw).map((c) => ({
    role: c.role as (typeof ROLES)[number],
    key: c.module as (typeof GRANT_KEYS)[number],
    actions: normalizeActions(c.actions),
  }));
  if (cells.some((c) => LOCKED_ROLES.includes(c.role))) throw badRequest("Super Admin permissions can't be changed");

  const edits = await withTenant(ctx, async (tx) => {
    const write = async (role: (typeof ROLES)[number], key: (typeof GRANT_KEYS)[number], value: string) => {
      const dflt = defaultGrants(role)[key] ?? "";
      const where = and(eq(rolePermissions.role, role), eq(rolePermissions.module, key));
      const [before] = await tx.select({ actions: rolePermissions.actions }).from(rolePermissions).where(where);
      if ((before?.actions ?? dflt) === value) return;
      if (value === dflt) {
        await tx.delete(rolePermissions).where(where);
      } else {
        await tx
          .insert(rolePermissions)
          .values({ role, module: key, actions: value, updatedBy: ctx.actor.userId })
          .onConflictDoUpdate({ target: [rolePermissions.tenantId, rolePermissions.role, rolePermissions.module], set: { actions: value, updatedBy: ctx.actor.userId, updatedAt: new Date() } });
      }
      await writeAudit(tx, ctx, {
        action: "role_permission.changed",
        entity: "role_permission",
        before: { role, module: key, actions: before?.actions ?? dflt },
        after: { role, module: key, actions: value },
      });
    };
    for (const c of cells) await write(c.role, c.key, c.actions);
    // A module switched on must be usable: View on the area it needs (the screen adds it too; this keeps the rule server-side).
    for (const c of cells) {
      const need = c.key.startsWith("screen.") && c.actions ? SCREEN_NEEDS[c.key.slice(7) as Screen] : null;
      if (!need) continue;
      const rows = await tx.select({ role: rolePermissions.role, module: rolePermissions.module, actions: rolePermissions.actions }).from(rolePermissions).where(eq(rolePermissions.role, c.role));
      const has = effectiveGrants(c.role, rows)[need] ?? "";
      if (!has.includes("V")) await write(c.role, need, normalizeActions(has + "V"));
    }
    return tx.select({ role: rolePermissions.role, module: rolePermissions.module, actions: rolePermissions.actions }).from(rolePermissions);
  });
  // This instance serves the new matrix at once; others within the 30 s cache (lib/auth/grants.ts).
  primeWorkspaceEdits(ctx.tenantId, edits);
  return cells.map((c) => ({ role: c.role, module: c.key, actions: c.actions }));
}

/** One cell (tests, scripts); `reset: true` = back to the default. */
export async function setRolePermission(ctx: SessionContext, raw: z.input<typeof PermissionInput>, reset = false): Promise<{ actions: string }> {
  const input = PermissionInput.parse(raw);
  const actions = reset ? (defaultGrants(input.role as (typeof ROLES)[number])[input.module as (typeof GRANT_KEYS)[number]] ?? "") : input.actions;
  const [saved] = await setRolePermissions(ctx, [{ ...input, actions }]);
  return { actions: saved!.actions };
}
