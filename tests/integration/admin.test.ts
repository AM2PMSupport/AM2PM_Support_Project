/**
 * Setup (admin) on real Postgres: permissions, defaults, one-time secrets,
 * audit trail and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";

vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));

process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.CRON_SECRET = "test-cron-secret-123456";
process.env.APP_URL = "https://crm.example.test";

const { createProcess, listProcesses, listDispositions, createDisposition } = await import("@/lib/admin/processes");
const { createUser, resetUserPassword, listUsers, updateUser } = await import("@/lib/admin/users");
const { createField, validateCustom, listFields } = await import("@/lib/admin/custom-fields");
const { createSource } = await import("@/lib/admin/sources");
const { saveCallerDesk, addDid, getTelephony, setCallSync } = await import("@/lib/admin/telephony");
const { tenantsWithTelephony } = await import("@/lib/platform-admin/tenants");
const { verifyPassword } = await import("@/lib/auth/password");
const { sha256Hex } = await import("@/lib/crypto");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let agent: SessionContext;
let other: SessionContext;

const as = (t: { tenantId: string; tenantSlug: string; timezone: string }, role: s.Role): SessionContext => ({
  ...t,
  accountId: crypto.randomUUID(),
  tenantName: t.tenantSlug,
  actor: { userId: crypto.randomUUID(), role, name: role },
});

const processInput = {
  name: "Kosmo · Sales",
  stages: ["New", "Hot", "Won"],
  wonStage: "Won",
  method: "percentage" as const,
  workingDays: [1, 2, 3, 4, 5],
  start: "09:30",
  end: "19:30",
  slaMinutes: 15,
  recycleHours: 24,
  dedupeField: "phoneKey",
  reEnquiryDays: null,
  status: "active" as const,
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "admin-a");
  admin = as(t, "admin");
  agent = as(t, "agent");
  other = as(await seedTenant(db, "admin-b"), "admin");
}, 60_000);
afterAll(async () => close());

describe("processes & outcomes", () => {
  it("creates a process with the crmv7 default outcomes and an audit entry", async () => {
    const p = await createProcess(admin, processInput);
    const outs = await listDispositions(admin, p.id);
    expect(outs.map((d) => d.code)).toEqual(["INTERESTED", "CALL_BACK", "NO_ANSWER", "BUSY", "NOT_INTERESTED", "WRONG_NUMBER", "CONVERTED", "DNC"]);
    const audit = await withTenant(admin, (tx) => tx.select().from(s.auditLogs).where(eq(s.auditLogs.action, "process.created")));
    expect(audit).toHaveLength(1);
  });

  it("rejects a won stage that is not a stage", async () => {
    await expect(createProcess(admin, { ...processInput, name: "Bad", wonStage: "Closed" })).rejects.toThrow(/won stage/);
  });

  it("does not let an agent create processes", async () => {
    await expect(createProcess(agent, { ...processInput, name: "Nope" })).rejects.toThrow(/permission/);
  });

  it("adds a custom outcome with a generated code", async () => {
    const [p] = await listProcesses(admin);
    const d = await createDisposition(admin, { processId: p!.id, label: "Site visit booked", category: "positive" });
    expect(d.code).toBe("SITE_VISIT_BOOKED");
  });

  it("keeps another tenant's processes invisible", async () => {
    expect(await listProcesses(other)).toEqual([]);
  });
});

describe("team", () => {
  const loginHash = async (userId: string) => {
    const [u] = await db.select({ a: s.users.accountId }).from(s.users).where(eq(s.users.id, userId));
    const [acc] = await db.select().from(s.accounts).where(eq(s.accounts.id, u!.a!));
    return acc!;
  };

  it("creates a user whose one-time password verifies against their login", async () => {
    const [p] = await listProcesses(admin);
    const { id, password } = await createUser(admin, {
      email: "Priya@Example.com", name: "Priya Nair", role: "agent", phone: "98111 22233", did: "", shareWeight: 40,
      maxOpenLeads: 50, dailyQuota: null, skills: ["hindi"], processIds: [p!.id], status: "active",
    });
    const [row] = await withTenant(admin, (tx) => tx.select().from(s.users).where(eq(s.users.id, id)));
    expect(row!.email).toBe("priya@example.com");
    expect(row!.agentPhone10).toBe("9811122233");
    const acc = await loginHash(id);
    expect(acc.email).toBe("priya@example.com");
    expect(acc.passwordHash).not.toContain(password!);
    expect(await verifyPassword(password!, acc.passwordHash!)).toBe(true);
    const listed = (await listUsers(admin)).find((u) => u.id === id)!;
    expect(listed.processIds).toEqual([p!.id]);
    expect("passwordHash" in listed).toBe(false); // never sent to the UI
  });

  it("resets a password (old one stops working)", async () => {
    const [u] = (await listUsers(admin)).filter((x) => x.email === "priya@example.com");
    const before = (await loginHash(u!.id)).passwordHash;
    const { password } = await resetUserPassword(admin, u!.id);
    const after = (await loginHash(u!.id)).passwordHash!;
    expect(after).not.toBe(before);
    expect(await verifyPassword(password, after)).toBe(true);
  });

  it("the restricted app role cannot read logins at all", async () => {
    const err = await withTenant(admin, (tx) => tx.select().from(s.accounts)).catch((e: unknown) => e as { cause?: { message?: string } });
    expect(String((err as { cause?: { message?: string } })?.cause?.message)).toMatch(/permission denied/);
  });

  it("cross-workspace logins: only a super admin links them; client admins can't reset them", async () => {
    const base = { name: "Asha Rao", role: "agent" as const, phone: "", did: "", shareWeight: 1, maxOpenLeads: 5, dailyQuota: null, skills: [], processIds: [], status: "active" as const };
    // Workspace A creates Asha.
    const a = await createUser(admin, { ...base, email: "asha@am2pm.test" });
    expect(a.password).toBeTruthy();
    // Workspace B's admin cannot attach the same login (would let A's admin reach B).
    await expect(createUser(other, { ...base, email: "asha@am2pm.test" })).rejects.toThrow(/another workspace/);
    // A super admin in B can — and Asha keeps her one password.
    const superB = { ...other, actor: { ...other.actor, role: "super_admin" as const } };
    const b = await createUser(superB, { ...base, email: "asha@am2pm.test" });
    expect(b.password).toBeNull();
    expect((await loginHash(b.id)).id).toBe((await loginHash(a.id)).id);
    // Now A's admin may not reset (or change the email of) a login that also opens B.
    await expect(resetUserPassword(admin, a.id)).rejects.toThrow(/other workspaces/);
    await expect(updateUser(admin, a.id, { ...base, email: "x@evil.test" })).rejects.toThrow(/other workspaces/);
  });

  it("a super admin renaming a multi-workspace login updates the email shown in EVERY workspace", async () => {
    const base = { name: "Ravi K", role: "agent" as const, phone: "", did: "", shareWeight: 1, maxOpenLeads: 5, dailyQuota: null, skills: [], processIds: [], status: "active" as const };
    const superA = { ...admin, actor: { ...admin.actor, role: "super_admin" as const } };
    const superB = { ...other, actor: { ...other.actor, role: "super_admin" as const } };
    const a = await createUser(superA, { ...base, email: "ravi.old@am2pm.test" });
    const b = await createUser(superB, { ...base, email: "ravi.old@am2pm.test" });
    await updateUser(superA, a.id, { ...base, email: "Ravi.New@am2pm.test" });
    const emailIn = async (ctx: typeof admin, id: string) => (await listUsers(ctx)).find((u) => u.id === id)?.email;
    expect(await emailIn(admin, a.id)).toBe("ravi.new@am2pm.test");
    expect(await emailIn(other, b.id)).toBe("ravi.new@am2pm.test"); // was left as the old address before the fix
    // Someone else in one of Ravi's workspaces already has the target email → refused, nothing renamed.
    await createUser(superB, { ...base, name: "Other", email: "taken@am2pm.test" });
    await expect(updateUser(superA, a.id, { ...base, email: "taken@am2pm.test" })).rejects.toThrow(/already uses this email/);
    expect(await emailIn(other, b.id)).toBe("ravi.new@am2pm.test");
  });

  it("stops an admin from creating a Super Admin, and rejects bad phones", async () => {
    const base = { name: "X Y", did: "", shareWeight: 1, maxOpenLeads: 5, dailyQuota: null, skills: [], processIds: [], status: "active" as const };
    await expect(createUser(admin, { ...base, email: "boss@example.com", role: "super_admin", phone: "" })).rejects.toThrow(/Super Admin/);
    await expect(createUser(admin, { ...base, email: "bad@example.com", role: "agent", phone: "12345" })).rejects.toThrow(/mobile/);
  });
});

describe("custom fields", () => {
  it("creates a dropdown and validates values", async () => {
    await createField(admin, { entity: "lead", processId: null, label: "Mattress size", type: "dropdown", options: ["Single", "Queen", "King"], required: true });
    const defs = await listFields(admin);
    expect(defs[0]!.key).toBe("mattress_size");
    expect(validateCustom(defs, { mattress_size: "King" }).errors).toEqual([]);
    expect(validateCustom(defs, { mattress_size: "Huge" }).errors[0]).toMatch(/one of/);
    expect(validateCustom(defs, {}).errors[0]).toMatch(/required/);
  });
});

describe("lead sources & telephony", () => {
  it("returns the source key once and stores only its hash", async () => {
    const [p] = await listProcesses(admin);
    const { id, key, url } = await createSource(admin, { kind: "web_form", processId: p!.id, fieldMap: { full_name: "name" } });
    expect(url).toBe(`https://crm.example.test/api/hooks/admin-a/${id}`);
    const [row] = await withTenant(admin, (tx) => tx.select().from(s.importSources).where(eq(s.importSources.id, id)));
    expect(row!.secretHash).toBe(sha256Hex(key));
  });

  it("connects CallerDesk (encrypted), returns the webhook URL once, maps a DID", async () => {
    const { webhookUrl } = await saveCallerDesk(admin, { authCode: "cd-auth-code-123" });
    expect(webhookUrl).toMatch(/\/api\/hooks\/admin-a\/telephony\/callerdesk\/[A-Za-z0-9_-]{16,}$/);
    const [row] = await withTenant(admin, (tx) => tx.select().from(s.integrations));
    expect(row!.credentialsEnc).not.toContain("cd-auth-code-123");
    const [p] = await listProcesses(admin);
    await addDid(admin, { number: "079 7154 4878", processId: p!.id, direction: "both", defaultForOutbound: true });
    const t = await getTelephony(admin);
    expect(t.dids[0]).toMatchObject({ number: "07971544878", number10: "7971544878" });
    expect(t.maskedWebhookUrl).toMatch(/\/callerdesk\/••••••$/);
  });

  it("the 15-min call-report sync can be switched off and on per workspace", async () => {
    expect((await getTelephony(admin)).syncCalls).toBe(true);
    expect(await tenantsWithTelephony()).toContain(admin.tenantId);
    await setCallSync(admin, false);
    expect((await getTelephony(admin)).syncCalls).toBe(false);
    expect(await tenantsWithTelephony()).not.toContain(admin.tenantId); // scheduled sync skips it
    await setCallSync(admin, true);
    expect(await tenantsWithTelephony()).toContain(admin.tenantId);
    const audit = await withTenant(admin, (tx) => tx.select({ a: s.auditLogs.action }).from(s.auditLogs));
    expect(audit.map((x) => x.a)).toEqual(expect.arrayContaining(["telephony.call_sync_off", "telephony.call_sync_on"]));
  });
});

describe("company settings, audit, sample data", () => {
  it("updates only the signed-in workspace and audits it; agents can't", async () => {
    const { updateCompany, getCompany } = await import("@/lib/admin/company");
    await updateCompany(admin, { name: "Kosmo Realty", timezone: "Asia/Dubai", currency: "AED" });
    expect(await getCompany(admin)).toMatchObject({ name: "Kosmo Realty", timezone: "Asia/Dubai", currency: "AED" });
    expect((await getCompany(other)).name).not.toBe("Kosmo Realty");
    await expect(updateCompany(agent, { name: "X", timezone: "UTC", currency: "INR" })).rejects.toThrow(/permission/);
    await expect(updateCompany(admin, { name: "Kosmo", timezone: "Mars/Olympus", currency: "INR" })).rejects.toThrow();
    const { listAudit } = await import("@/lib/admin/audit-log");
    expect((await listAudit(admin)).items.some((a) => a.action === "workspace.settings_updated")).toBe(true);
    await expect(listAudit(agent)).rejects.toThrow(/permission/);
  });

  it("removes only the demo process and its leads", async () => {
    const { removeSampleData, sampleDataSummary, SAMPLE_PROCESS_NAME } = await import("@/lib/admin/sample-data");
    const demo = await createProcess(admin, { ...processInput, name: SAMPLE_PROCESS_NAME });
    const real = await createProcess(admin, { ...processInput, name: "Real · Sales" });
    for (const pid of [demo.id, real.id]) {
      await withTenant(admin, async (tx) => {
        const [c] = await tx.insert(s.contacts).values({ name: "C", phoneE164: "+915500000009", phoneKey: crypto.randomUUID().slice(0, 10) }).returning();
        await tx.insert(s.leads).values({ processId: pid, contactId: c!.id, source: { kind: "manual" }, stage: "New", dedupeKey: crypto.randomUUID() });
      });
    }
    expect(await sampleDataSummary(admin)).toEqual({ leads: 1 });
    expect(await removeSampleData(admin)).toEqual({ removed: 1 });
    expect(await sampleDataSummary(admin)).toBeNull();
    const left = await withTenant(admin, (tx) => tx.select().from(s.leads).where(eq(s.leads.processId, real.id)));
    expect(left).toHaveLength(1);
  });
});
