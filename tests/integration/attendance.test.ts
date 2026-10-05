/**
 * Attendance (Jibble) on real Postgres (PGlite): sync with the Jibble API
 * mocked — email matching, overlapping polls without duplicate events,
 * current state, leave → users.on_leave_on — then the screen data per role
 * and workspace, and the app role locked out of the platform tables.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";
import { localToday } from "@/lib/reports/period";
import { randomBytes } from "node:crypto";

process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.CRON_SECRET ??= "test-cron-secret-0123456789";

vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));
vi.mock("@/lib/redis/client", async (importOriginal) => {
  const { fakeRedis } = await import("../helpers/db");
  const r = fakeRedis();
  return { ...(await importOriginal<typeof import("@/lib/redis/client")>()), redis: () => r };
});
const TODAY = localToday("Asia/Kolkata");
const P1 = "00000000-0000-4000-8000-000000000001"; // Asha (agent, workspace A)
const P2 = "00000000-0000-4000-8000-000000000002"; // Ravi (agent, workspace A) — on leave
const P3 = "00000000-0000-4000-8000-000000000003"; // nobody in the CRM
const at = (hhmm: string) => new Date(`${TODAY}T${hhmm}:00+05:30`);
const entry = (n: number, personId: string, type: string, hhmm: string) => ({ id: `10000000-0000-4000-8000-00000000000${n}`, personId, type, at: at(hhmm), belongsToDate: TODAY });
const jibbleMock = {
  people: vi.fn(async () => [
    { id: P1, email: "asha@att.test", fullName: "Asha", code: "E1", status: "Active" },
    { id: P2, email: "RAVI@att.test", fullName: "Ravi", code: "E2", status: "Active" },
    { id: P3, email: "ghost@att.test", fullName: "Ghost", code: null, status: "Active" },
  ]),
  entriesSince: vi.fn(async () => [entry(1, P1, "In", "09:00"), entry(2, P1, "StartBreak", "11:00")]),
  leave: vi.fn(async () => [{ id: "L1", personId: P2, startDate: TODAY, endDate: TODAY, status: "Approved", kind: "Casual" }]),
  holidays: vi.fn(async () => [{ date: `${TODAY.slice(0, 4)}-12-25`, name: "Christmas" }]),
  test: vi.fn(),
};
vi.mock("@/lib/providers/workforce/jibble", () => ({ jibble: jibbleMock }));
const { saveJibble, syncAttendance, jibbleStatus } = await import("@/lib/platform-admin/attendance");
const { attendanceToday, leaveView } = await import("@/lib/attendance/view");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let asha: SessionContext;
let ravi: SessionContext;
let other: SessionContext;

async function member(t: Awaited<ReturnType<typeof seedTenant>>, email: string, role: Role): Promise<SessionContext> {
  const [acc] = await db.insert(s.accounts).values({ email }).onConflictDoUpdate({ target: s.accounts.email, set: { email } }).returning();
  const base = { ...t, accountId: acc!.id, tenantName: t.tenantSlug };
  const [u] = await withTenant({ ...base, actor: { userId: "", role, name: email } }, (tx) => tx.insert(s.users).values({ email, name: email.split("@")[0]!, role, accountId: acc!.id }).returning());
  return { ...base, actor: { userId: u!.id, role, name: email } };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const a = await seedTenant(db, "att-a");
  admin = await member(a, "boss@att.test", "super_admin");
  asha = await member(a, "asha@att.test", "agent");
  ravi = await member(a, "ravi@att.test", "agent");
  other = await member(await seedTenant(db, "att-b"), "admin@b.test", "admin");
  await saveJibble(admin, { clientId: "client-id-123", clientSecret: "client-secret-456" });
}, 60_000);
afterAll(async () => close());

describe("attendance sync", () => {
  it("only a Super Admin can connect Jibble", async () => {
    await expect(saveJibble({ ...other, actor: { ...other.actor, role: "admin" } }, { clientId: "x".repeat(10), clientSecret: "y".repeat(10) })).rejects.toMatchObject({ status: 403 });
  });

  it("links people by email, stores events once across overlapping polls, sets state and leave", async () => {
    await syncAttendance({ force: true });
    await syncAttendance({ force: true }); // same events again (overlap) → no duplicates
    const status = await jibbleStatus();
    expect(status).toMatchObject({ connected: true, people: 3, linked: 2 });
    expect(status.unmatched.map((p) => p.fullName)).toEqual(["Ghost"]);
    expect(await db.select().from(s.workforceEntries)).toHaveLength(2);
    const [p1] = await db.select().from(s.workforcePeople).where(eq(s.workforcePeople.id, P1));
    expect(p1).toMatchObject({ state: "break", accountId: asha.accountId, linkedBy: "email" });
    const [r] = await db.select({ on: s.users.onLeaveOn }).from(s.users).where(eq(s.users.id, ravi.actor.userId));
    expect(r!.on).toBe(TODAY);
    const [a] = await db.select({ on: s.users.onLeaveOn }).from(s.users).where(eq(s.users.id, asha.actor.userId));
    expect(a!.on).toBeNull();
  });
});

describe("attendance screen data", () => {
  it("admin sees the workspace: presence, worked time, leave", async () => {
    // Pin "last poll" to just before the test's clock, so presence doesn't depend on when the suite runs.
    await db.update(s.workforceConnections).set({ entriesSyncedAt: at("11:58") });
    const t = await attendanceToday(admin, at("12:00").getTime());
    const a = t.rows.find((x) => x.userId === asha.actor.userId)!;
    expect(a).toMatchObject({ linked: true, presence: "break", firstIn: at("09:00").getTime(), workedSec: 7200, breakSec: 3600 });
    expect(t.rows.find((x) => x.userId === ravi.actor.userId)).toMatchObject({ onLeave: true });
    expect(t.rows.find((x) => x.userId === admin.actor.userId)).toMatchObject({ linked: false });
    const lv = await leaveView(admin, at("12:00").getTime());
    expect(lv.onLeaveToday.map((l) => l.name)).toEqual(["ravi"]);
    expect(lv.holidays.map((h) => h.name)).toEqual(["Christmas"]);
  });

  it("an agent sees only themselves; another workspace sees none of these people", async () => {
    expect((await attendanceToday(asha)).rows.map((x) => x.userId)).toEqual([asha.actor.userId]);
    const b = await attendanceToday(other);
    expect(b.rows.map((x) => x.userId)).toEqual([other.actor.userId]);
    expect(b.rows[0]!.linked).toBe(false);
  });

  it("the app role cannot read the platform attendance tables", async () => {
    const err = await withTenant(admin, (tx) => tx.execute(sql`select * from workforce_people`)).catch((e: Error & { cause?: unknown }) => e);
    expect(String((err as { cause?: unknown }).cause ?? err)).toMatch(/permission denied/);
  });
});
