/**
 * Team members — Setup (T1.13).
 *
 * Creating a user generates a strong password that is returned ONCE to the
 * admin who created it (never stored in plain text, never logged). Roles can
 * only be granted at or below the actor's level; nobody but a Super Admin
 * creates Super Admins.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { userProcesses, users, type Role } from "@/lib/db/schema";
import { isUniqueViolation, withTenant } from "@/lib/db/tenant";
import { changeLoginEmail, loginForNewMember, resetLoginPassword } from "@/lib/platform-admin/auth";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { badRequest, conflict, forbidden, notFound } from "@/lib/http/errors";
import { isValidMobile10, toE164, toTenDigits } from "@/lib/phone/phone";

const ROLES = ["super_admin", "admin", "project_supervisor", "manager", "process_coordinator", "trainer", "client", "agent"] as const;
const RANK: Record<Role, number> = { super_admin: 7, admin: 6, project_supervisor: 5, manager: 4, process_coordinator: 3, trainer: 2, agent: 2, client: 1 };

export const UserInput = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(2).max(80),
  role: z.enum(ROLES),
  phone: z.string().trim().max(20).optional().default(""),
  did: z.string().trim().max(20).optional().default(""),
  shareWeight: z.number().int().min(0).max(1000).default(1),
  maxOpenLeads: z.number().int().min(1).max(10000).default(50),
  dailyQuota: z.number().int().min(0).max(10000).nullable().default(null),
  skills: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  processIds: z.array(z.uuid()).max(50).default([]),
  status: z.enum(["active", "inactive", "locked"]).default("active"),
});
export type UserInput = z.infer<typeof UserInput>;

function assertCanGrant(ctx: SessionContext, role: Role) {
  const mine = ctx.actor.role;
  if (role === "super_admin" && mine !== "super_admin") throw forbidden("Only a Super Admin can create Super Admins");
  if (RANK[role] > RANK[mine]) throw forbidden("You can't grant a role above your own");
}

function phoneFields(phone: string) {
  if (!phone) return { agentPhoneE164: null, agentPhone10: null };
  const ten = toTenDigits(phone);
  if (!isValidMobile10(ten)) throw badRequest("Enter a valid 10-digit mobile number");
  return { agentPhoneE164: toE164(phone), agentPhone10: ten };
}

export async function listUsers(ctx: SessionContext) {
  requirePermission(ctx, "users", "V");
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        agentPhoneE164: users.agentPhoneE164,
        agentPhoneVerifiedAt: users.agentPhoneVerifiedAt,
        did: users.did,
        shareWeight: users.shareWeight,
        maxOpenLeads: users.maxOpenLeads,
        openLeads: users.openLeads,
        dailyQuota: users.dailyQuota,
        skills: users.skills,
        isAvailable: users.isAvailable,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .orderBy(asc(users.name));
    const maps = await tx.select().from(userProcesses);
    return rows.map((u) => ({ ...u, processIds: maps.filter((m) => m.userId === u.id).map((m) => m.processId) }));
  });
}

/**
 * Add a person to this workspace. A brand-new email gets a login whose
 * password is returned ONCE; an email that already has an AM2PM login keeps
 * its password (only super admins may link those — lib/platform-admin/auth).
 */
export async function createUser(ctx: SessionContext, input: UserInput): Promise<{ id: string; password: string | null }> {
  requirePermission(ctx, "users", "C");
  assertCanGrant(ctx, input.role);
  const { accountId, password } = await loginForNewMember(input.email, ctx.tenantId, ctx.actor.role === "super_admin");
  try {
    const id = await withTenant(ctx, async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: input.email.toLowerCase(),
          name: input.name,
          role: input.role,
          ...phoneFields(input.phone),
          did: input.did || null,
          shareWeight: input.shareWeight,
          maxOpenLeads: input.maxOpenLeads,
          dailyQuota: input.dailyQuota,
          skills: input.skills,
          status: input.status,
          accountId,
        })
        .returning({ id: users.id });
      if (input.processIds.length) await tx.insert(userProcesses).values(input.processIds.map((processId) => ({ userId: u!.id, processId })));
      await writeAudit(tx, ctx, { action: "user.created", entity: "user", entityId: u!.id, after: { email: input.email, role: input.role, existingLogin: password === null } });
      return u!.id;
    });
    return { id, password };
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A user with this email already exists in this workspace");
    throw err;
  }
}

export async function updateUser(ctx: SessionContext, id: string, input: UserInput) {
  requirePermission(ctx, "users", "E");
  assertCanGrant(ctx, input.role);
  // The email is the person's login: change it there FIRST, outside the
  // tenant transaction (platform connection; refused if they work in other
  // workspaces). Never call the platform DB from inside withTenant.
  const [login] = await withTenant(ctx, (tx) => tx.select({ role: users.role, email: users.email, accountId: users.accountId }).from(users).where(eq(users.id, id)));
  if (!login) throw notFound("User not found");
  assertCanGrant(ctx, login.role);
  if (login.accountId && login.email.toLowerCase() !== input.email.toLowerCase()) {
    await changeLoginEmail(login.accountId, ctx.tenantId, input.email, ctx.actor.role === "super_admin");
  }
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select({ role: users.role, status: users.status, email: users.email }).from(users).where(eq(users.id, id));
    if (!before) throw notFound("User not found");
    assertCanGrant(ctx, before.role);
    if (id === ctx.actor.userId && input.status !== "active") throw badRequest("You can't deactivate yourself");
    await tx
      .update(users)
      .set({
        email: input.email.toLowerCase(),
        name: input.name,
        role: input.role,
        ...phoneFields(input.phone),
        did: input.did || null,
        shareWeight: input.shareWeight,
        maxOpenLeads: input.maxOpenLeads,
        dailyQuota: input.dailyQuota,
        skills: input.skills,
        status: input.status,
        ...(input.status !== "active" ? { isAvailable: false } : {}),
      })
      .where(eq(users.id, id));
    // Replace process mapping.
    await tx.delete(userProcesses).where(eq(userProcesses.userId, id));
    if (input.processIds.length) await tx.insert(userProcesses).values(input.processIds.map((processId) => ({ userId: id, processId })));
    await writeAudit(tx, ctx, { action: "user.updated", entity: "user", entityId: id, before, after: { role: input.role, status: input.status, processes: input.processIds.length } });
  });
}

export async function resetUserPassword(ctx: SessionContext, id: string): Promise<{ password: string }> {
  requirePermission(ctx, "users", "E");
  const [u] = await withTenant(ctx, (tx) => tx.select({ role: users.role, accountId: users.accountId }).from(users).where(eq(users.id, id)));
  if (!u) throw notFound("User not found");
  assertCanGrant(ctx, u.role);
  if (!u.accountId) throw badRequest("This user has no login yet — ask an AM2PM super admin to link it");
  // Platform call outside the tenant transaction (refuses multi-workspace logins for non-super-admins).
  const password = await resetLoginPassword(u.accountId, ctx.tenantId, ctx.actor.role === "super_admin");
  await withTenant(ctx, (tx) => writeAudit(tx, ctx, { action: "user.password_reset", entity: "user", entityId: id }));
  return { password };
}

/** Agents set their own availability (presence also mirrored in Redis by call events). */
export async function setMyAvailability(ctx: SessionContext, available: boolean) {
  return withTenant(ctx, (tx) => tx.update(users).set({ isAvailable: available }).where(and(eq(users.id, ctx.actor.userId), eq(users.status, "active"))));
}

export async function userNames(ctx: SessionContext, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await withTenant(ctx, (tx) => tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}
