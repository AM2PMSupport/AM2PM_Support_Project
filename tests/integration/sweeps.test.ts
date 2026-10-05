/**
 * Background sweeps on real Postgres, budgeted for QStash's free 1,000
 * messages/day (2026-10-03 outage: per-lead messages used it up by
 * mid-morning and every schedule + webhook stopped until midnight UTC).
 *   - sweep-unassigned assigns INLINE: zero QStash messages per lead;
 *     a lead nobody can take stays unassigned without costing anything.
 *   - stuck webhooks ("received", never queued) are re-queued once per sweep.
 *   - the single `tick` runs the 15-minute work only on quarter-hour ticks.
 * Scale (200–300 clients, 2026-10-05): per-client caps, call sync in turn
 * (cursor) or fanned out with QUEUE_FANOUT=1, chunked retention purge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, fakeRedis, seedTenant, type TestDb } from "../helpers/db";
import type { TenantContext } from "@/lib/tenancy/context";

const enqueued: { job: string; payload: Record<string, unknown> }[] = [];
vi.mock("@/lib/queue/qstash", () => ({
  enqueue: vi.fn(async (job: string, payload: Record<string, unknown>) => {
    enqueued.push({ job, payload });
    return "msg";
  }),
  verifyQStash: vi.fn(),
}));
const redisFake = fakeRedis();
vi.mock("@/lib/redis/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/redis/client")>()), redis: () => redisFake }));
const ran: string[] = [];
vi.mock("@/lib/platform-admin/reminders", () => ({ runCallbackReminders: vi.fn(async () => (ran.push("reminders"), {})) }));
vi.mock("@/lib/telephony/sync", () => ({ syncCalls: vi.fn(async () => (ran.push("sync"), { rows: 0, failed: 0 })) }));

const { sweepUnassigned, requeueStuckWebhooks, purgeExpired } = await import("@/lib/platform-admin/sweeps");
const { syncCalls } = await import("@/lib/telephony/sync");
const { handlers } = await import("@/lib/jobs/handlers");

let db: TestDb;
let close: () => Promise<void>;
let T: TenantContext;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  T = await seedTenant(db, "sweeps-t");
}, 60_000);
afterAll(async () => close());
beforeEach(() => {
  enqueued.length = 0;
  ran.length = 0;
});

async function lead(processId: string) {
  return withTenant(T, async (tx) => {
    const [c] = await tx.insert(s.contacts).values({ name: "x" }).returning();
    const [l] = await tx.insert(s.leads).values({ processId, contactId: c!.id, source: { kind: "manual" }, stage: "New", dedupeKey: `nokey:${crypto.randomUUID()}` }).returning();
    return l!.id;
  });
}

describe("sweep-unassigned", () => {
  it("assigns inline, sends no QStash messages, and leaves leads nobody can take", async () => {
    const { staffed, empty } = await withTenant(T, async (tx) => {
      const [a] = await tx.insert(s.processes).values({ name: "Staffed", stages: ["New"], assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
      const [b] = await tx.insert(s.processes).values({ name: "No agents", stages: ["New"], assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
      const [u] = await tx.insert(s.users).values({ email: "ag@sweeps.test", name: "Agent", role: "agent", isAvailable: true }).returning();
      await tx.insert(s.userProcesses).values({ userId: u!.id, processId: a!.id });
      return { staffed: a!.id, empty: b!.id };
    });
    const ok = await lead(staffed);
    const stuck = await lead(empty);

    const r = await sweepUnassigned();
    expect(r).toMatchObject({ assigned: 1 });
    expect(r.tried).toBeGreaterThanOrEqual(2);
    expect(enqueued).toEqual([]); // the old version sent one message per lead, every run

    const owner = (id: string) => withTenant(T, (tx) => tx.select({ a: s.leads.assignedTo }).from(s.leads).where(eq(s.leads.id, id)));
    expect((await owner(ok))[0]!.a).not.toBeNull();
    expect((await owner(stuck))[0]!.a).toBeNull();
  });

  it("stops at its time budget (the next run continues)", async () => {
    const r = await sweepUnassigned(-1);
    expect(r.tried).toBe(0);
  });
});

describe("requeueStuckWebhooks", () => {
  it("re-queues only events still 'received' after 2 minutes", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const ids = await withTenant(T, async (tx) => {
      const mk = (key: string, status: "received" | "done", createdAt: Date) =>
        tx.insert(s.webhookEvents).values({ source: "telephony:callerdesk", idempotencyKey: key, payload: {}, status, createdAt }).returning({ id: s.webhookEvents.id });
      const [[lost], [fresh], [done]] = await Promise.all([mk("lost", "received", old), mk("fresh", "received", new Date()), mk("done", "done", old)]);
      return { lost: lost!.id, fresh: fresh!.id, done: done!.id };
    });
    expect(await requeueStuckWebhooks()).toBe(1);
    expect(enqueued).toEqual([{ job: "process-webhook", payload: { tenantId: T.tenantId, webhookEventId: ids.lost } }]);
  });
});

describe("tick (the one schedule)", () => {
  it("runs reminders every time and the 15-minute work only on quarter-hour ticks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T06:05:00Z"));
      await handlers.tick({});
      expect(ran).toEqual(["reminders"]);
      ran.length = 0;
      vi.setSystemTime(new Date("2026-10-04T06:15:00Z"));
      await handlers.tick({});
      expect(ran).toContain("reminders");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scale: fairness across clients", () => {
  it("a client with many unassignable leads gets at most 25 tries per sweep", async () => {
    const F = await seedTenant(db, "sweeps-flood");
    const p = await withTenant(F, async (tx) => (await tx.insert(s.processes).values({ name: "Nobody", stages: ["New"], assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning())[0]!.id);
    await withTenant(F, async (tx) => {
      for (let i = 0; i < 40; i++) {
        const [c] = await tx.insert(s.contacts).values({ name: `f${i}` }).returning();
        await tx.insert(s.leads).values({ processId: p, contactId: c!.id, source: { kind: "manual" }, stage: "New", dedupeKey: `nokey:${crypto.randomUUID()}`, createdAt: new Date(Date.now() - 86_400_000) });
      }
    });
    const before = await withTenant(T, (tx) => tx.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.status, "open")));
    const r = await sweepUnassigned();
    // ≤ 25 from the flooding client + this test file's other client's unassigned leads.
    expect(r.tried).toBeLessThanOrEqual(25 + before.length);
    expect(r.tried).toBeGreaterThanOrEqual(25);
  });
});

describe("scale: call sync across clients", () => {
  let tenants: TenantContext[];
  beforeAll(async () => {
    tenants = [await seedTenant(db, "sync-a"), await seedTenant(db, "sync-b")];
    for (const t of tenants) await withTenant(t, (tx) => tx.insert(s.integrations).values({ kind: "telephony", provider: "callerdesk", credentialsEnc: "x" }));
  });

  it("inline (free plan): syncs clients in turn and remembers where it stopped", async () => {
    vi.mocked(syncCalls).mockClear();
    await handlers["sync-calls"]({});
    const synced = vi.mocked(syncCalls).mock.calls.map((c) => (c[0] as TenantContext).tenantId);
    for (const t of tenants) expect(synced).toContain(t.tenantId);
    expect(redisFake.store.get("platform:calls:sync_cursor")).toBe(synced.at(-1));
    expect(enqueued.filter((e) => e.job === "sync-calls-tenant")).toEqual([]);
  });

  it("QUEUE_FANOUT=1 but the queue is degraded (quota / lapsed plan): syncs inline instead", async () => {
    const { resetQueueHealthCache } = await import("@/lib/queue/health");
    vi.mocked(syncCalls).mockClear();
    redisFake.store.set("platform:queue:degraded", JSON.stringify({ since: new Date().toISOString(), reason: "test" }));
    resetQueueHealthCache();
    process.env.QUEUE_FANOUT = "1";
    try {
      await handlers["sync-calls"]({});
    } finally {
      delete process.env.QUEUE_FANOUT;
      redisFake.store.delete("platform:queue:degraded");
      resetQueueHealthCache();
    }
    expect(vi.mocked(syncCalls)).toHaveBeenCalled();
    expect(enqueued.filter((e) => e.job === "sync-calls-tenant")).toEqual([]);
  });

  it("QUEUE_FANOUT=1 (paid plan): one job per client, nothing synced inline", async () => {
    vi.mocked(syncCalls).mockClear();
    process.env.QUEUE_FANOUT = "1";
    try {
      await handlers["sync-calls"]({});
    } finally {
      delete process.env.QUEUE_FANOUT;
    }
    expect(vi.mocked(syncCalls)).not.toHaveBeenCalled();
    const jobs = enqueued.filter((e) => e.job === "sync-calls-tenant").map((e) => e.payload.tenantId);
    for (const t of tenants) expect(jobs).toContain(t.tenantId);
  });
});

describe("scale: retention purge", () => {
  it("deletes expired rows in chunks and keeps fresh ones", async () => {
    await withTenant(T, async (tx) => {
      await tx.insert(s.webhookEvents).values({ source: "x", idempotencyKey: "old-purge", payload: {}, status: "done", createdAt: new Date(Date.now() - 61 * 86_400_000) });
      await tx.insert(s.webhookEvents).values({ source: "x", idempotencyKey: "new-purge", payload: {}, status: "done" });
    });
    const r = await purgeExpired();
    expect(r.webhookEvents).toBeGreaterThanOrEqual(1);
    const left = await withTenant(T, (tx) => tx.select({ k: s.webhookEvents.idempotencyKey }).from(s.webhookEvents));
    expect(left.map((x) => x.k)).toContain("new-purge");
    expect(left.map((x) => x.k)).not.toContain("old-purge");
  });
});

