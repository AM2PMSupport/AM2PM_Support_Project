/**
 * Nightly backups (T1.43–T1.44) on real Postgres (PGlite, real RLS) with the
 * backup store in memory: one snapshot per workspace per day, each holding
 * only its own workspace's rows (encrypted, checksummed, readable back),
 * paging across files incl. composite primary keys, resuming after the time
 * budget runs out, retention pruning, and a failure raising the alert.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";
import { localToday } from "@/lib/reports/period";

process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.CRON_SECRET ??= "test-cron-secret-0123456789";
process.env.BACKUP_READ_WRITE_TOKEN = "test-token";
vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));
vi.mock("@/lib/redis/client", async (importOriginal) => {
  const { fakeRedis } = await import("../helpers/db");
  const r = fakeRedis();
  return { ...(await importOriginal<typeof import("@/lib/redis/client")>()), redis: () => r };
});
const store = new Map<string, Buffer>();
vi.mock("@/lib/backups/store", () => ({
  backupStoreConfigured: () => !!process.env.BACKUP_READ_WRITE_TOKEN,
  putBackupFile: vi.fn(async (p: string, b: Buffer) => void store.set(p, b)),
  readBackupFile: vi.fn(async (p: string) => {
    const b = store.get(p);
    if (!b) throw new Error("missing");
    return b;
  }),
  deleteBackupFiles: vi.fn(async (ps: string[]) => ps.forEach((p) => store.delete(p))),
}));
const { runBackups, readSnapshotTable } = await import("@/lib/platform-admin/backups");

let db: TestDb;
let close: () => Promise<void>;
let a: SessionContext;
let b: SessionContext;
const TODAY = localToday("Asia/Kolkata");
const at = (hhmm: string) => new Date(`${TODAY}T${hhmm}:00+05:30`);

async function mk(t: Awaited<ReturnType<typeof seedTenant>>, email: string, role: Role): Promise<SessionContext> {
  const base = { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug };
  const [u] = await withTenant({ ...base, actor: { userId: "", role, name: email } }, (tx) => tx.insert(s.users).values({ email, name: email, role }).returning());
  return { ...base, actor: { userId: u!.id, role, name: email } };
}
async function seedLeads(ctx: SessionContext, n: number, prefix: string) {
  await withTenant(ctx, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "Sales", stages: ["New"], wonStage: "New", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    for (let i = 0; i < n; i++) {
      const [c] = await tx.insert(s.contacts).values({ name: `${prefix}${i}`, phoneE164: `+91${prefix === "A" ? 97 : 96}${String(i).padStart(8, "0")}`, phoneKey: `${prefix === "A" ? 97 : 96}${String(i).padStart(8, "0")}` }).returning();
      await tx.insert(s.leads).values({ processId: p!.id, contactId: c!.id, source: { kind: "csv" }, stage: "New", dedupeKey: `${prefix}${i}` });
    }
    await tx.insert(s.rolePermissions).values([{ role: "agent", module: "leads", actions: "V" }, { role: "manager", module: "leads", actions: "VE" }]);
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  a = await mk(await seedTenant(db, "bk-a"), "boss@a.test", "super_admin");
  b = await mk(await seedTenant(db, "bk-b"), "boss@b.test", "super_admin");
  await seedLeads(a, 7, "A");
  await seedLeads(b, 3, "B");
}, 60_000);
afterAll(async () => close());

const snaps = () => db.select().from(s.backupSnapshots);

describe("backups", () => {
  it("before 01:00 workspace time nothing is created", async () => {
    await runBackups(Date.now() + 60_000, at("00:30"), 3);
    expect(await snaps()).toEqual([]);
  });

  it("creates one snapshot per workspace; no time left → they wait; next run completes; once per day", async () => {
    // A budget inside the safety margin: snapshots are created but not started.
    expect(await runBackups(Date.now() + 1_000, at("01:40"), 3)).toBe("0 done, 0 in progress, 0 failed");
    expect((await snaps()).map((x) => x.status)).toEqual(["running", "running"]);
    expect(await runBackups(Date.now() + 60_000, at("02:00"), 3)).toMatch(/^2 done/);
    await runBackups(Date.now() + 60_000, at("03:00"), 3); // same day: no second snapshot
    const all = await snaps();
    expect(all).toHaveLength(2);
    expect(all.every((x) => x.status === "completed" && x.cursor === null && x.sizeBytes > 0)).toBe(true);
  });

  it("each snapshot holds only its workspace's rows, paged across files, encrypted and readable back", async () => {
    const [snapA] = await db.select().from(s.backupSnapshots).where(eq(s.backupSnapshots.tenantId, a.tenantId));
    const leadsA = await readSnapshotTable(snapA!.id, "leads");
    expect(leadsA).toHaveLength(7);
    expect(leadsA.every((r) => r.tenant_id === a.tenantId)).toBe(true);
    expect(Object.keys(snapA!.files).filter((k) => k.startsWith("leads."))).toEqual(["leads.0", "leads.1", "leads.2"]); // 3 + 3 + 1
    expect((await readSnapshotTable(snapA!.id, "contacts")).map((r) => r.name).sort()).toEqual(["A0", "A1", "A2", "A3", "A4", "A5", "A6"]);
    expect(await readSnapshotTable(snapA!.id, "role_permissions")).toHaveLength(2); // composite primary key paging
    expect((await readSnapshotTable(snapA!.id, "tenants"))[0]).toMatchObject({ id: a.tenantId });
    expect([...store.values()].some((buf) => buf.toString("utf8").includes("A0"))).toBe(false);
    // Outbox event for subscribers.
    const ev = await withTenant(a, (tx) => tx.select().from(s.outbox).where(eq(s.outbox.eventType, "backup.completed")));
    expect(ev).toHaveLength(1);
  });

  it("resumes from the saved cursor without missing or repeating rows", async () => {
    const [snapA] = await db.select().from(s.backupSnapshots).where(eq(s.backupSnapshots.tenantId, a.tenantId));
    const first = await readSnapshotTable(snapA!.id, "leads").then((r) => r.slice(0, 3));
    const tables = (await import("@/lib/platform-admin/backups")).backupTables;
    const idx = (await tables()).findIndex((t) => t.name === "leads");
    // As if the 60 s limit hit right after leads.0: later files dropped, cursor after its last row.
    const kept = Object.fromEntries(Object.entries(snapA!.files).filter(([k]) => !k.startsWith("leads.") || k === "leads.0"));
    await db.update(s.backupSnapshots).set({ status: "running", files: kept, cursor: { table: idx, after: [first[2]!.id], chunk: 1 } }).where(eq(s.backupSnapshots.id, snapA!.id));
    await runBackups(Date.now() + 60_000, at("02:30"), 3);
    const all = await readSnapshotTable(snapA!.id, "leads");
    expect(all).toHaveLength(7);
    expect(new Set(all.map((r) => r.id)).size).toBe(7);
  });

  it("keeps 7 daily / 4 weekly / 3 monthly and deletes older snapshots with their files", async () => {
    const [snapA] = await db.select().from(s.backupSnapshots).where(eq(s.backupSnapshots.tenantId, a.tenantId));
    const oldKey = `backups/${a.tenantId}/old/leads.0.amb`;
    store.set(oldKey, Buffer.from("x"));
    for (let i = 1; i <= 40; i++) {
      const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
      await db.insert(s.backupSnapshots).values({ tenantId: a.tenantId, trigger: "manual", status: "completed", day, files: i === 40 ? { "leads.0": { rows: 1, bytes: 1, sha256: "x", key: oldKey } } : {} });
    }
    // A failed run tomorrow triggers nothing here; a successful one prunes: run a fresh snapshot.
    await db.update(s.backupSnapshots).set({ status: "running", cursor: { table: 0, after: null, chunk: 0 }, files: {} }).where(eq(s.backupSnapshots.id, snapA!.id));
    await runBackups(Date.now() + 60_000, at("04:00"), 100);
    const left = await db.select({ day: s.backupSnapshots.day }).from(s.backupSnapshots).where(eq(s.backupSnapshots.tenantId, a.tenantId));
    expect(left.length).toBeLessThanOrEqual(7 + 4 + 3);
    expect(store.has(oldKey)).toBe(false);
  });

  it("a failure marks the snapshot failed, emits backup.failed and alerts the Super Admins", async () => {
    const [snapB] = await db.select().from(s.backupSnapshots).where(eq(s.backupSnapshots.tenantId, b.tenantId));
    await db.update(s.backupSnapshots).set({ status: "running", keyEnc: "not-a-key", cursor: { table: 0, after: null, chunk: 0 } }).where(eq(s.backupSnapshots.id, snapB!.id));
    expect(await runBackups(Date.now() + 60_000, at("05:00"), 100)).toMatch(/1 failed/);
    const [after] = await db.select().from(s.backupSnapshots).where(eq(s.backupSnapshots.id, snapB!.id));
    expect(after).toMatchObject({ status: "failed" });
    const ev = await withTenant(b, (tx) => tx.select().from(s.outbox).where(eq(s.outbox.eventType, "backup.failed")));
    expect(ev).toHaveLength(1);
    const n = await withTenant(b, (tx) => tx.execute(sql`select title from notifications where user_id = ${b.actor.userId}`));
    expect(n.rows.map((r) => r.title)).toContain("Nightly backup failed");
  });
});
