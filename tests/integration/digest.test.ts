/**
 * Manager digest (T1.42) on real Postgres (PGlite) with email mocked:
 * recipients (admins / supervisors / managers, not agents), each in their
 * own scope, 09:00–12:00 workspace time only, once a day, and nothing sent
 * (nothing marked) while email isn't configured.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";
import { localToday } from "@/lib/reports/period";

process.env.APP_URL ??= "https://crm.example.test";
vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));
vi.mock("@/lib/redis/client", async (importOriginal) => {
  const { fakeRedis } = await import("../helpers/db");
  const r = fakeRedis();
  return { ...(await importOriginal<typeof import("@/lib/redis/client")>()), redis: () => r };
});
const sent: { to: string; subject: string; html: string; idempotencyKey?: string }[] = [];
vi.mock("@/lib/providers/email/resend", () => ({
  emailConfigured: () => !!process.env.RESEND_API_KEY,
  sendEmail: vi.fn(async (m: { to: string; subject: string; html: string; idempotencyKey?: string }) => (sent.push(m), { ok: true, id: "x" })),
}));
const { runDigests } = await import("@/lib/platform-admin/digest");

let db: TestDb;
let close: () => Promise<void>;
const TODAY = localToday("Asia/Kolkata");
const at = (hhmm: string) => new Date(`${TODAY}T${hhmm}:00+05:30`);

async function mk(t: Awaited<ReturnType<typeof seedTenant>>, email: string, role: Role, name: string): Promise<SessionContext> {
  const base = { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug };
  const [u] = await withTenant({ ...base, actor: { userId: "", role, name } }, (tx) => tx.insert(s.users).values({ email, name, role, maxOpenLeads: 100 }).returning());
  return { ...base, actor: { userId: u!.id, role, name } };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "digest-t");
  const admin = await mk(t, "admin@d.test", "admin", "Anita Admin");
  const manager = await mk(t, "mgr@d.test", "manager", "Manoj Manager");
  await mk(t, "agent@d.test", "agent", "Asha Agent");
  await withTenant(admin, async (tx) => {
    const [sales] = await tx.insert(s.processes).values({ name: "Sales", stages: ["New", "Hot", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    const [support] = await tx.insert(s.processes).values({ name: "Support", stages: ["New"], wonStage: "New", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    await tx.insert(s.userProcesses).values({ userId: manager.actor.userId, processId: sales!.id });
    const lead = async (i: number, processId: string, extra: Partial<typeof s.leads.$inferInsert> = {}) => {
      const [c] = await tx.insert(s.contacts).values({ name: `Lead ${i}`, phoneE164: `+91980000000${i}`, phoneKey: `980000000${i}` }).returning();
      await tx.insert(s.leads).values({ processId, contactId: c!.id, source: { kind: "web_form" }, stage: "New", dedupeKey: `980000000${i}`, ...extra });
    };
    await lead(1, sales!.id, { stage: "Hot", lastDisposition: { code: "int", label: "Interested", category: "positive", at: at("08:00").toISOString() } });
    await lead(2, sales!.id);
    await lead(3, support!.id); // outside the manager's processes
  });
}, 60_000);
afterAll(async () => close());

describe("manager digest", () => {
  it("does nothing (and marks nothing) while email isn't configured", async () => {
    delete process.env.RESEND_API_KEY;
    expect(await runDigests(Date.now() + 30_000, at("09:30"))).toBe("email not configured");
    expect(sent).toHaveLength(0);
  });

  it("not before 09:00 workspace time", async () => {
    process.env.RESEND_API_KEY = "re_test";
    await runDigests(Date.now() + 30_000, at("08:45"));
    expect(sent).toHaveLength(0);
  });

  it("09:30: admin + manager get it (not the agent), each in their own scope, once a day", async () => {
    await runDigests(Date.now() + 30_000, at("09:30"));
    expect(sent.map((m) => m.to).sort()).toEqual(["admin@d.test", "mgr@d.test"]);
    const mgr = sent.find((m) => m.to === "mgr@d.test")!;
    const adm = sent.find((m) => m.to === "admin@d.test")!;
    expect(mgr.html).toContain("Good morning, Manoj");
    expect(mgr.html).toContain("your processes");
    expect(adm.html).toContain("whole workspace");
    expect(mgr.html).toContain("Lead 1"); // hot lead in Sales
    // Never-called open leads: manager sees Sales only (2), admin the workspace (3).
    expect(mgr.html).toMatch(/Never called<\/div><div[^>]*>2</);
    expect(adm.html).toMatch(/Never called<\/div><div[^>]*>3</);
    expect(mgr.idempotencyKey).toMatch(/^digest:/);
    await runDigests(Date.now() + 30_000, at("10:00")); // later tick, same day
    expect(sent).toHaveLength(2);
  });
});
