/**
 * Background sweeps on real Postgres, budgeted for QStash's free 1,000
 * messages/day (2026-10-03 outage: per-lead messages used it up by
 * mid-morning and every schedule + webhook stopped until midnight UTC).
 *   - sweep-unassigned assigns INLINE: zero QStash messages per lead;
 *     a lead nobody can take stays unassigned without costing anything.
 *   - stuck webhooks ("received", never queued) are re-queued once per sweep.
 *   - the single `tick` runs the 15-minute work only on quarter-hour ticks.
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

const { sweepUnassigned, requeueStuckWebhooks } = await import("@/lib/platform-admin/sweeps");
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
