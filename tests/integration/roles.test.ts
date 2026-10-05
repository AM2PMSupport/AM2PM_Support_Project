/**
 * Setup → Roles & permissions on real Postgres: Super Admin only, Super Admin
 * column locked, defaults stored as "no row", audit trail, the edit reaching
 * permission checks (grantsFor), and tenant isolation (RULE.md §1).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";
import type { TenantContext } from "@/lib/tenancy/context";

vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));

const { setRolePermission, setRolePermissions } = await import("@/lib/admin/roles");
const { grantsFor, workspaceEdits } = await import("@/lib/auth/grants");
const { can, navFor } = await import("@/lib/auth/rbac");

let db: TestDb;
let close: () => Promise<void>;
let a: TenantContext;
let b: TenantContext;
let superA: SessionContext;
let adminA: SessionContext;
let superB: SessionContext;

async function person(t: TenantContext, role: s.Role): Promise<SessionContext> {
  const [u] = await withTenant(t, (tx) => tx.insert(s.users).values({ email: `${role}-${crypto.randomUUID()}@x.test`, name: role, role }).returning({ id: s.users.id }));
  return { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug, actor: { userId: u!.id, role, name: role } };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  a = await seedTenant(db, "roles-a");
  b = await seedTenant(db, "roles-b");
  superA = await person(a, "super_admin");
  adminA = await person(a, "admin");
  superB = await person(b, "super_admin");
});
afterAll(async () => close?.());

describe("role permission edits", () => {
  it("only a Super Admin may edit, and never Super Admin's own column", async () => {
    await expect(setRolePermission(adminA, { role: "agent", module: "leads", actions: "V" })).rejects.toMatchObject({ status: 403 });
    await expect(setRolePermission(superA, { role: "super_admin", module: "config", actions: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("saves an edit, applies it to checks, audits it, and isolates it per workspace", async () => {
    expect(await setRolePermission(superA, { role: "manager", module: "leads", actions: "IXV" })).toEqual({ actions: "VXI" });

    const g = await grantsFor(a, "manager");
    expect(can({ role: "manager", grants: g }, "leads", "I")).toBe(true);
    expect(can({ role: "manager", grants: g }, "leads", "E")).toBe(false); // default VCEAX replaced

    // Workspace B is untouched (RLS + per-tenant cache).
    expect(await workspaceEdits(b)).toEqual([]);
    expect(can({ role: "manager", grants: await grantsFor(b, "manager") }, "leads", "E")).toBe(true);

    const audit = await withTenant(a, (tx) => tx.select().from(s.auditLogs).where(eq(s.auditLogs.action, "role_permission.changed")));
    expect(audit.length).toBe(1);
  });

  it("an edit equal to the default (or a reset) leaves no row", async () => {
    await setRolePermission(superA, { role: "manager", module: "leads", actions: "VCEAX" });
    expect(await withTenant(a, (tx) => tx.select().from(s.rolePermissions))).toEqual([]);

    await setRolePermission(superA, { role: "trainer", module: "reports", actions: "VX" });
    await setRolePermission(superA, { role: "trainer", module: "reports", actions: "" }, true);
    expect(await withTenant(a, (tx) => tx.select().from(s.rolePermissions))).toEqual([]);
  });

  it("can't write into another workspace's matrix", async () => {
    await setRolePermission(superB, { role: "agent", module: "leads", actions: "" });
    expect(await withTenant(a, (tx) => tx.select().from(s.rolePermissions))).toEqual([]);
    const rowsB = await withTenant(b, (tx) => tx.select().from(s.rolePermissions));
    expect(rowsB.map((r) => [r.role, r.module, r.actions])).toEqual([["agent", "leads", ""]]);
  });

  it("switching a module on for a role also grants View on the area it needs", async () => {
    await setRolePermission(superA, { role: "hr", module: "screen.leads", actions: "V" });
    const g = await grantsFor(a, "hr");
    expect(can({ role: "hr", grants: g }, "leads", "V")).toBe(true);
    expect(navFor({ role: "hr", grants: g })).toContain("leads");
    // Switching it off again leaves the granted permission (the matrix is changed separately).
    await setRolePermission(superA, { role: "hr", module: "screen.leads", actions: "" });
    expect(navFor({ role: "hr", grants: await grantsFor(a, "hr") })).not.toContain("leads");
    await withTenant(a, (tx) => tx.delete(s.rolePermissions));
  });

  it("Save writes a batch in one go, and a bad cell saves nothing", async () => {
    await setRolePermissions(superA, [
      { role: "agent", module: "screen.dashboard", actions: "V" },
      { role: "manager", module: "leads", actions: "VX" },
    ]);
    const rows = await withTenant(a, (tx) => tx.select().from(s.rolePermissions));
    expect(rows.map((r) => [r.role, r.module, r.actions]).sort()).toEqual([["agent", "screen.dashboard", "V"], ["manager", "leads", "VX"]]);

    await expect(setRolePermissions(superA, [{ role: "manager", module: "leads", actions: "VCEAX" }, { role: "super_admin", module: "leads", actions: "" }])).rejects.toMatchObject({ status: 400 });
    expect(await withTenant(a, (tx) => tx.select().from(s.rolePermissions))).toHaveLength(2);

    // "Default" = every cell back to its default → no rows left.
    await setRolePermissions(superA, [{ role: "agent", module: "screen.dashboard", actions: "" }, { role: "manager", module: "leads", actions: "VCEAX" }]);
    expect(await withTenant(a, (tx) => tx.select().from(s.rolePermissions))).toEqual([]);
  });

  it("rejects letters outside VCEDAXI", async () => {
    await expect(setRolePermission(superA, { role: "agent", module: "leads", actions: "VZ" })).rejects.toThrow();
  });
});
