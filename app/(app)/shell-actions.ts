"use server";

/**
 * Shell-wide actions: notifications bell and the workspace switcher.
 *
 * Switching (Zoho-style "jump to organisation"): the cookie is re-issued for
 * the person's membership in the chosen workspace, so EVERYTHING that
 * follows — settings, leads, processes, telephony, people — is that
 * workspace's, enforced by RLS on tenant_id. The membership is re-checked
 * live on every switch; tenantId comes from the server-side membership
 * list, never trusted from the client (RULE.md §1.7). The person stays on the
 * module they were on when the new role can open it (landingAfterSwitch).
 */
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/session";
import { markAllRead, myNotifications } from "@/lib/notifications";
import { accountEmail, allActiveWorkspaces, ensureSuperAdminMembership, membershipsOf, recordLogin } from "@/lib/platform-admin/auth";
import { sessionCookieOptions, sessionToken } from "@/lib/auth/cookie";
import { landingAfterSwitch } from "@/lib/auth/rbac";
import { withTenant, isUuid } from "@/lib/db/tenant";
import { writeAudit } from "@/lib/audit";
import { log } from "@/lib/log";

export async function notificationsAction() {
  const ctx = await getSession();
  if (!ctx) return { unread: 0, items: [] };
  try {
    return await myNotifications(ctx);
  } catch {
    return { unread: 0, items: [] };
  }
}

export async function markAllReadAction() {
  const ctx = await getSession();
  if (ctx) await markAllRead(ctx);
}

export interface WorkspaceOption {
  id: string;
  name: string;
  role: string | null; // null = not a member yet (super admin can enter)
  current: boolean;
}

export async function workspacesAction(): Promise<WorkspaceOption[]> {
  const ctx = await getSession();
  if (!ctx) return [];
  const mine = await membershipsOf(ctx.accountId);
  const options: WorkspaceOption[] = mine.map((m) => ({ id: m.tenantId, name: m.tenantName, role: m.role, current: m.tenantId === ctx.tenantId }));
  if (mine.some((m) => m.role === "super_admin")) {
    for (const w of await allActiveWorkspaces()) {
      if (!options.some((o) => o.id === w.id)) options.push({ id: w.id, name: w.name, role: null, current: false });
    }
  }
  return options;
}

/** `from` = the page the switch was made on; the person stays there if the new role allows it. */
export async function switchWorkspaceAction(tenantId: string, from?: string): Promise<{ ok: true; home: string } | { ok: false; error: string }> {
  const ctx = await getSession();
  if (!ctx) return { ok: false, error: "Your session has ended. Sign in again." };
  if (!isUuid(tenantId)) return { ok: false, error: "Unknown workspace" };
  try {
    const mine = await membershipsOf(ctx.accountId);
    let m = mine.find((x) => x.tenantId === tenantId);
    let entered = false;
    if (!m) {
      // Only a super admin (in any of their workspaces) may enter a workspace they don't belong to.
      if (!mine.some((x) => x.role === "super_admin")) return { ok: false, error: "You don't have access to that workspace" };
      const email = await accountEmail(ctx.accountId);
      if (!email) return { ok: false, error: "Your login was not found. Sign in again." };
      m = await ensureSuperAdminMembership(ctx.accountId, email, ctx.actor.name, tenantId);
      entered = true;
    }
    const target = { tenantId: m.tenantId, tenantSlug: m.tenantSlug, timezone: m.tenantTimezone, actor: { userId: m.userId, role: m.role, name: m.name } };
    await withTenant(target, (tx) =>
      writeAudit(tx, target, { action: entered ? "workspace.entered_by_super_admin" : "workspace.switched_in", entity: "user", entityId: m.userId, after: { from: ctx.tenantSlug } }),
    );
    await recordLogin(ctx.accountId, m.userId, m.tenantId);
    (await cookies()).set({ ...sessionCookieOptions, value: sessionToken(ctx.accountId, m) });
    return { ok: true, home: landingAfterSwitch(m.role, from) };
  } catch (err) {
    log.error("workspace switch failed", { err });
    return { ok: false, error: err instanceof Error && "status" in err ? err.message : "Could not switch workspace. Try again." };
  }
}
