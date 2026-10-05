/**
 * QStash safety net (lib/queue/health.ts) on real Postgres: when the queue
 * refuses publishes (free quota used up, paid plan lapsed, outage) nothing is
 * lost and work keeps flowing — webhooks still answer 200 and are processed
 * inline by the sweep, new leads are assigned inline, fan-out switches off,
 * Super Admins are alerted once, and the next good publish clears it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, fakeRedis, seedTenant, type TestDb } from "../helpers/db";
import type { TenantContext } from "@/lib/tenancy/context";

// The real enqueue() runs; only the QStash HTTP client is replaced.
let qstashUp = true;
const published: string[] = [];
vi.mock("@upstash/qstash", () => ({
  Client: class {
    async publishJSON(req: { url: string }) {
      if (!qstashUp) throw new Error("QStash: daily message quota exceeded (429)");
      published.push(req.url.split("/api/jobs/")[1]!);
      return { messageId: "m" };
    }
  },
  Receiver: class {},
}));
const redisFake = fakeRedis();
vi.mock("@/lib/redis/client", async (orig) => ({ ...(await orig<typeof import("@/lib/redis/client")>()), redis: () => redisFake }));
process.env.QSTASH_TOKEN ??= "t";
process.env.QSTASH_CURRENT_SIGNING_KEY ??= "k";
process.env.QSTASH_NEXT_SIGNING_KEY ??= "k";
process.env.APP_URL ??= "https://crm.example.test";

const { enqueue } = await import("@/lib/queue/qstash");
const { queueDegraded, resetQueueHealthCache, failureReason } = await import("@/lib/queue/health");
const { receiveWebhook } = await import("@/lib/webhooks/receive");
const { requeueStuckWebhooks } = await import("@/lib/platform-admin/sweeps");
const { createOrMergeLead } = await import("@/lib/leads/create");

let db: TestDb;
let close: () => Promise<void>;
let T: TenantContext;
let processId: string;
let sourceId: string;
let superId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  T = await seedTenant(db, "qsafe-t");
  ({ processId, sourceId, superId } = await withTenant(T, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "Sales", stages: ["New"], assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    const [a] = await tx.insert(s.users).values({ email: "ag@q.test", name: "Agent", role: "agent", isAvailable: true }).returning();
    await tx.insert(s.userProcesses).values({ userId: a!.id, processId: p!.id });
    const [sa] = await tx.insert(s.users).values({ email: "sa@q.test", name: "Boss", role: "super_admin" }).returning();
    const [src] = await tx.insert(s.importSources).values({ kind: "web_form", processId: p!.id, secretHash: "x" }).returning();
    return { processId: p!.id, sourceId: src!.id, superId: sa!.id };
  }));
}, 60_000);
afterAll(async () => close());
beforeEach(() => {
  qstashUp = true;
  published.length = 0;
  redisFake.store.clear();
  resetQueueHealthCache();
});

const alerts = () => withTenant(T, (tx) => tx.select().from(s.notifications).where(eq(s.notifications.userId, superId)));

describe("queue health", () => {
  it("a refused publish marks the queue degraded, alerts Super Admins once; a good publish clears it", async () => {
    qstashUp = false;
    await expect(enqueue("relay-outbox", {})).rejects.toThrow(/quota/);
    await expect(enqueue("relay-outbox", {})).rejects.toThrow();
    resetQueueHealthCache();
    expect(await queueDegraded()).toBe(true);
    expect((await alerts()).filter((n) => n.kind === "system")).toHaveLength(1); // once per episode
    qstashUp = true;
    await enqueue("relay-outbox", {});
    resetQueueHealthCache();
    expect(await queueDegraded()).toBe(false);
  });

  it("classifies the reason without leaking details", () => {
    expect(failureReason(new Error("daily quota exceeded"))).toMatch(/quota/);
    expect(failureReason(new Error("payment required 402"))).toMatch(/billing/);
    expect(failureReason(new Error("ECONNRESET"))).toBe("QStash unreachable");
  });
});

describe("fallback paths while the queue refuses", () => {
  it("a webhook is still stored and answered (no 500), then processed inline by the sweep", async () => {
    qstashUp = false;
    const r = await receiveWebhook({ ctx: T, source: `source:${sourceId}`, payload: { name: "Queue Down", phone: "9876512345" }, rawBody: '{"lead":"q1"}' });
    expect(r).toEqual({ duplicate: false });
    // Age it past the sweep's 2-minute grace, then sweep with the queue still down.
    await withTenant(T, (tx) => tx.update(s.webhookEvents).set({ createdAt: new Date(Date.now() - 5 * 60_000) }).where(eq(s.webhookEvents.status, "received")));
    resetQueueHealthCache();
    expect(await requeueStuckWebhooks()).toBeGreaterThanOrEqual(1);
    const evs = await withTenant(T, (tx) => tx.select({ status: s.webhookEvents.status }).from(s.webhookEvents));
    expect(evs.every((e) => e.status === "done")).toBe(true);
    const leads = await withTenant(T, (tx) => tx.select({ assignedTo: s.leads.assignedTo }).from(s.leads).innerJoin(s.contacts, eq(s.contacts.id, s.leads.contactId)).where(eq(s.contacts.name, "Queue Down")));
    expect(leads).toHaveLength(1);
    expect(leads[0]!.assignedTo).not.toBeNull(); // assigned inline, not via assign-lead
  });

  it("a new lead is assigned inline when assign-lead can't be queued", async () => {
    qstashUp = false;
    const [proc] = await withTenant(T, (tx) => tx.select().from(s.processes).where(eq(s.processes.id, processId)));
    const r = await createOrMergeLead(T, proc!, { name: "Inline", phoneE164: "+919876599999", phoneKey: "9876599999", custom: {} }, { kind: "manual" });
    const [l] = await withTenant(T, (tx) => tx.select({ a: s.leads.assignedTo }).from(s.leads).where(eq(s.leads.id, r.leadId)));
    expect(l!.a).not.toBeNull();
    expect(published).not.toContain("assign-lead");
  });
});
