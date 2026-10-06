/**
 * Logins and workspace memberships (Zoho-style org switching).
 *
 * One `accounts` row per person (email + ONE password) and one `users` row
 * per workspace they belong to (role per workspace). Sign-in happens before
 * a tenant is known, and memberships span tenants, so this reads across
 * tenants with the owner connection — which is why it lives in
 * platform-admin (RULE.md §1.5). The RLS role has no access to `accounts`.
 *
 * Trust rules (SECURITY.md §2.4):
 *   - A workspace admin may only create logins for emails that have NO
 *     membership in another workspace. Linking an existing login into a
 *     further workspace is a super-admin action.
 *   - A workspace admin may reset a password only if that login belongs to
 *     their workspace alone. Otherwise an admin of client A could take over
 *     an AM2PM staff login and walk into client B.
 *   - Switching workspace re-checks the membership live (active user,
 *     active workspace) on every switch.
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { accounts, auditLogs, tenants, users, type Role } from "@/lib/db/schema";
import { platformDb } from "@/lib/platform-admin/db";
import { generatePassword, hashPassword } from "@/lib/auth/password";
import { conflict, forbidden } from "@/lib/http/errors";

const ACTIVE_TENANT = ["active", "trial"] as const;

export interface Membership {
  userId: string;
  role: Role;
  name: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantTimezone: string;
}

export async function findAccount(email: string) {
  const [a] = await platformDb()
    .select({ id: accounts.id, passwordHash: accounts.passwordHash, lastTenantId: accounts.lastTenantId })
    .from(accounts)
    .where(eq(accounts.email, email.trim().toLowerCase()));
  return a ?? null;
}

/** Workspaces this login can open right now (active membership in an active workspace), A→Z. */
export async function membershipsOf(accountId: string): Promise<Membership[]> {
  return platformDb()
    .select({
      userId: users.id,
      role: users.role,
      name: users.name,
      tenantId: tenants.id,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
      tenantTimezone: tenants.timezone,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(users.accountId, accountId), eq(users.status, "active"), inArray(tenants.status, [...ACTIVE_TENANT])))
    .orderBy(asc(tenants.name));
}

/** Super admins can open every active workspace, member or not. */
export async function allActiveWorkspaces() {
  return platformDb()
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(inArray(tenants.status, [...ACTIVE_TENANT]))
    .orderBy(asc(tenants.name));
}

export async function recordLogin(accountId: string, userId: string, tenantId: string): Promise<void> {
  const now = new Date();
  await platformDb().update(accounts).set({ lastLoginAt: now, lastTenantId: tenantId }).where(eq(accounts.id, accountId));
  await platformDb().update(users).set({ lastLoginAt: now }).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
  // Login history per workspace (Reports → Agents: login time of the day).
  await platformDb().insert(auditLogs).values({ tenantId, actorId: userId, action: "auth.login", entity: "user", entityId: userId, createdAt: now });
}

/**
 * A super admin opening a workspace they're not a member of: create (or
 * reactivate) a super_admin membership for their login there. Refuses if
 * that workspace already has a DIFFERENT person under this email.
 */
export async function ensureSuperAdminMembership(accountId: string, email: string, name: string, tenantId: string): Promise<Membership> {
  const db = platformDb();
  const [existing] = await db.select({ id: users.id, accountId: users.accountId }).from(users).where(and(eq(users.tenantId, tenantId), eq(sql`lower(${users.email})`, email.toLowerCase())));
  if (existing && existing.accountId !== accountId) throw conflict("This workspace already has a different user with your email");
  if (existing) await db.update(users).set({ status: "active", role: "super_admin" }).where(eq(users.id, existing.id));
  else await db.insert(users).values({ tenantId, accountId, email: email.toLowerCase(), name, role: "super_admin" });
  const m = (await membershipsOf(accountId)).find((x) => x.tenantId === tenantId);
  if (!m) throw forbidden("That workspace is not active");
  return m;
}

/** Email of a login (for super-admin membership rows). */
export async function accountEmail(accountId: string): Promise<string | null> {
  const [a] = await platformDb().select({ email: accounts.email }).from(accounts).where(eq(accounts.id, accountId));
  return a?.email ?? null;
}

/**
 * Login for a NEW membership in `tenantId`. Returns the account id and, when
 * a password was (re)issued, that password — shown once to the admin.
 */
export async function loginForNewMember(email: string, tenantId: string, actorIsSuperAdmin: boolean): Promise<{ accountId: string; password: string | null }> {
  const db = platformDb();
  const e = email.trim().toLowerCase();
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  // Race-safe create (RULE.md §2.1): no find-then-insert.
  const [created] = await db.insert(accounts).values({ email: e, passwordHash, passwordChangedAt: new Date() }).onConflictDoNothing({ target: accounts.email }).returning({ id: accounts.id });
  if (created) return { accountId: created.id, password };

  const [acc] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, e));
  const elsewhere = await db.select({ tenantId: users.tenantId }).from(users).where(and(eq(users.accountId, acc!.id), ne(users.tenantId, tenantId))).limit(1);
  if (elsewhere.length) {
    if (!actorIsSuperAdmin) throw conflict("This person already has an AM2PM login in another workspace. Ask an AM2PM super admin to add them here.");
    return { accountId: acc!.id, password: null }; // they keep their existing password
  }
  // A login with no other workspace (e.g. its user was removed): issue a fresh password.
  await db.update(accounts).set({ passwordHash, passwordChangedAt: new Date() }).where(eq(accounts.id, acc!.id));
  return { accountId: acc!.id, password };
}

/** Reset a login's password from inside a workspace, enforcing the single-workspace rule for non-super-admins. */
export async function resetLoginPassword(accountId: string, tenantId: string, actorIsSuperAdmin: boolean): Promise<string> {
  const db = platformDb();
  if (!actorIsSuperAdmin) {
    const elsewhere = await db.select({ id: users.id }).from(users).where(and(eq(users.accountId, accountId), ne(users.tenantId, tenantId))).limit(1);
    if (elsewhere.length) throw forbidden("This person also works in other workspaces — only an AM2PM super admin can reset their password");
  }
  const password = generatePassword();
  await db.update(accounts).set({ passwordHash: await hashPassword(password), passwordChangedAt: new Date() }).where(eq(accounts.id, accountId));
  return password;
}

/** Keep the login email in step when a single-workspace user's email is edited. */
export async function changeLoginEmail(accountId: string, tenantId: string, newEmail: string, actorIsSuperAdmin: boolean): Promise<void> {
  const db = platformDb();
  const e = newEmail.trim().toLowerCase();
  const [acc] = await db.select({ email: accounts.email }).from(accounts).where(eq(accounts.id, accountId));
  if (!acc || acc.email === e) return;
  if (!actorIsSuperAdmin) {
    const elsewhere = await db.select({ id: users.id }).from(users).where(and(eq(users.accountId, accountId), ne(users.tenantId, tenantId))).limit(1);
    if (elsewhere.length) throw forbidden("This person also works in other workspaces — only an AM2PM super admin can change their email");
  }
  const [taken] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, e));
  if (taken) throw conflict("Another login already uses this email");
  // In any workspace this person belongs to, someone else may already be listed with that email.
  const [clash] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${e}`, sql`${users.accountId} is distinct from ${accountId}`, sql`${users.tenantId} in (select tenant_id from users where account_id = ${accountId})`))
    .limit(1);
  if (clash) throw conflict("Someone else in one of this person's workspaces already uses this email");
  // The login IS the email: rename it and every workspace's member row together, or
  // other workspaces keep listing an address that no longer signs in (2026-10-06).
  await db.transaction(async (tx) => {
    await tx.update(accounts).set({ email: e }).where(eq(accounts.id, accountId));
    await tx.update(users).set({ email: e }).where(eq(users.accountId, accountId));
  });
}
