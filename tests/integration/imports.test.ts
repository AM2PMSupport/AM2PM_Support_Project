/**
 * CSV import on real Postgres (RLS): chunks of 500, dedupe within the file
 * and against existing leads, inline assignment, per-row errors, a
 * redelivered chunk counted once, file deleted at the end.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";

const files = new Map<string, string>();
const enqueue = vi.fn(async () => "msg");
vi.mock("@/lib/queue/qstash", () => ({ enqueue, verifyQStash: vi.fn() }));
vi.mock("@/lib/storage/blob", () => ({
  tenantPrefix: (t: string, a: string) => `${a}/${t}/`,
  readPrivateBlob: async (p: string) => Buffer.from(files.get(p) ?? ""),
  deletePrivateBlob: async (p: string) => void files.delete(p),
}));
vi.mock("@/lib/redis/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/redis/client")>()),
  redis: () => ({ get: async () => null, set: async () => "OK", del: async () => 1, mget: async (...k: string[]) => k.map(() => null) }),
}));
const { startImport, runImportChunk } = await import("@/lib/imports/run");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let agentId: string;
let processId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "imports-t");
  const ctx0 = { ...t, actor: { userId: "", role: "admin" as const, name: "a" } };
  const [a] = await withTenant(ctx0, (tx) => tx.insert(s.users).values({ email: "admin@x.test", name: "Admin", role: "admin" }).returning());
  admin = { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug, actor: { userId: a!.id, role: "admin", name: "Admin" } };
  await withTenant(admin, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "P", stages: ["New", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    processId = p!.id;
    const [ag] = await tx.insert(s.users).values({ email: "ag@x.test", name: "Agent", role: "agent", isAvailable: true, maxOpenLeads: 5000 }).returning();
    agentId = ag!.id;
    await tx.insert(s.userProcesses).values({ userId: agentId, processId });
  });
}, 60_000);
afterAll(async () => close());

const batchRow = async (id: string) => (await withTenant(admin, (tx) => tx.select().from(s.importBatches).where(eq(s.importBatches.id, id))))[0]!;

describe("CSV import", () => {
  it("rejects files outside the tenant's upload area", async () => {
    await expect(startImport(admin, { processId, pathname: "imports/other-tenant/x.csv", fileName: "x.csv" })).rejects.toThrow(/workspace/);
  });

  it("imports 1,203 rows in 3 chunks: new, duplicates, failures, assignment", async () => {
    const lines = ["Full Name,Mobile No,Email"];
    for (let i = 0; i < 1200; i++) lines.push(`Lead ${i},98${String(i).padStart(8, "0")},`);
    lines.push("Dup of 0,9800000000,"); // duplicate inside the file
    lines.push("Bad,12345,"); // invalid phone, no email
    lines.push("Email only,,only@x.in");
    const path = `imports/${admin.tenantId}/leads.csv`;
    files.set(path, lines.join("\n"));

    const { batchId } = await startImport(admin, { processId, pathname: path, fileName: "leads.csv" });
    expect(enqueue).toHaveBeenLastCalledWith("import-batch", { tenantId: admin.tenantId, batchId, offset: 0 }, expect.anything());

    expect(await runImportChunk(admin, batchId, 0)).toEqual({ done: false });
    expect((await batchRow(batchId)).status).toBe("running");
    // QStash redelivers chunk 500 after it was processed → no double count.
    await runImportChunk(admin, batchId, 500);
    const mid = await batchRow(batchId);
    await runImportChunk(admin, batchId, 500);
    expect((await batchRow(batchId)).inserted).toBe(mid.inserted);
    expect(await runImportChunk(admin, batchId, 1000)).toEqual({ done: true });

    const b = await batchRow(batchId);
    expect(b).toMatchObject({ status: "done", total: 1203, inserted: 1201, merged: 1, failed: 1 });
    expect(b.errors).toEqual([{ row: 1203, reason: "no valid phone or email" }]);
    expect(files.has(path)).toBe(false);

    const leads = await withTenant(admin, (tx) => tx.select({ a: s.leads.assignedTo, src: s.leads.source }).from(s.leads));
    expect(leads).toHaveLength(1201);
    expect(leads.every((l) => l.a === agentId && l.src.kind === "csv" && l.src.batchId === batchId)).toBe(true);
    // No per-lead assign jobs: only the 3 chunk messages.
    expect(enqueue.mock.calls.filter((c) => (c as unknown[])[0] === "assign-lead")).toHaveLength(0);
  }, 120_000);

  it("a file that can't be parsed marks the batch failed with a reason", async () => {
    const path = `imports/${admin.tenantId}/broken.xlsx`;
    files.set(path, "not really excel");
    const { batchId } = await startImport(admin, { processId, pathname: path, fileName: "broken.xlsx" });
    expect(await runImportChunk(admin, batchId, 0)).toEqual({ done: true });
    const b = await batchRow(batchId);
    expect(b.status).toBe("failed");
    expect(b.errors[0]!.row).toBe(0);
  });
});
