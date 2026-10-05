/**
 * Integration tests on real Postgres (PGlite) with the production migrations,
 * including row-level security. QStash and Redis are replaced by in-memory
 * fakes; everything else is the real code path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, fakeRedis, seedTenant, type TestDb } from "../helpers/db";
import type { TenantContext } from "@/lib/tenancy/context";

// --- fakes for external services ------------------------------------------
const enqueued: { job: string; payload: Record<string, unknown> }[] = [];
vi.mock("@/lib/queue/qstash", () => ({
  enqueue: vi.fn(async (job: string, payload: Record<string, unknown>) => {
    enqueued.push({ job, payload });
    return "msg_test";
  }),
  verifyQStash: vi.fn(),
}));
const redisFake = fakeRedis();
vi.mock("@/lib/redis/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/redis/client")>()),
  redis: () => redisFake,
}));

// Imported after mocks are registered.
const { createOrMergeLead } = await import("@/lib/leads/create");
const { assignLead } = await import("@/lib/assignment/assign");
const { applyCallEvents } = await import("@/lib/telephony/call-events");
const { receiveWebhook } = await import("@/lib/webhooks/receive");

let db: TestDb;
let close: () => Promise<void>;
let A: TenantContext;
let B: TenantContext;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  A = await seedTenant(db, "tenant-a");
  B = await seedTenant(db, "tenant-b");
}, 60_000);
afterAll(async () => close());
beforeEach(() => {
  enqueued.length = 0;
});

/** Seed a process (+ optional agents mapped to it) inside a tenant. */
async function seedProcess(ctx: TenantContext, method: s.AssignmentMethod = "equal") {
  return withTenant(ctx, async (tx) => {
    const [p] = await tx
      .insert(s.processes)
      .values({ name: `P-${method}`, stages: ["New", "Won"], assignment: { method, sticky: false, slaMinutes: 15 } })
      .returning();
    return p!;
  });
}

async function seedAgent(ctx: TenantContext, processId: string, over: Partial<typeof s.users.$inferInsert> = {}) {
  return withTenant(ctx, async (tx) => {
    const [u] = await tx
      .insert(s.users)
      .values({ email: `${crypto.randomUUID()}@x.test`, name: "Agent", role: "agent", isAvailable: true, ...over })
      .returning();
    await tx.insert(s.userProcesses).values({ userId: u!.id, processId });
    return u!;
  });
}

// ---------------------------------------------------------------------------
describe("row-level security (tenant isolation)", () => {
  it("stamps tenant_id automatically and hides rows from other tenants", async () => {
    const [c] = await withTenant(A, (tx) => tx.insert(s.contacts).values({ name: "A's customer" }).returning());
    expect(c!.tenantId).toBe(A.tenantId);

    const seenByB = await withTenant(B, (tx) => tx.select().from(s.contacts).where(eq(s.contacts.id, c!.id)));
    expect(seenByB).toEqual([]);

    const updatedByB = await withTenant(B, (tx) =>
      tx.update(s.contacts).set({ name: "hacked" }).where(eq(s.contacts.id, c!.id)).returning(),
    );
    expect(updatedByB).toEqual([]);
  });

  it("refuses to write a row for another tenant", async () => {
    await expect(
      withTenant(B, (tx) => tx.insert(s.contacts).values({ tenantId: A.tenantId, name: "smuggled" })),
    ).rejects.toThrow();
  });

  it("lets a tenant read only its own tenants row", async () => {
    const rows = await withTenant(A, (tx) => tx.select({ slug: s.tenants.slug }).from(s.tenants));
    expect(rows).toEqual([{ slug: "tenant-a" }]);
  });

  it("makes audit_logs append-only for the app role", async () => {
    const [log] = await withTenant(A, (tx) => tx.insert(s.auditLogs).values({ action: "test", entity: "lead" }).returning());
    await expect(withTenant(A, (tx) => tx.delete(s.auditLogs).where(eq(s.auditLogs.id, log!.id)))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("lead create / dedupe", () => {
  it("creates once, then merges a repeat enquiry (same phone, same process)", async () => {
    const process = await seedProcess(A);
    const lead = { phoneKey: "9811111111", phoneE164: "+919811111111", custom: {} };

    const first = await createOrMergeLead(A, process, lead, { kind: "web_form" });
    const second = await createOrMergeLead(A, process, lead, { kind: "meta_ads" });

    expect(first.outcome).toBe("created");
    expect(second).toEqual({ outcome: "merged", leadId: first.leadId });

    const rows = await withTenant(A, (tx) => tx.select().from(s.leads).where(eq(s.leads.processId, process.id)));
    expect(rows).toHaveLength(1);
    const events = await withTenant(A, (tx) => tx.select({ type: s.leadEvents.type }).from(s.leadEvents).where(eq(s.leadEvents.leadId, first.leadId)));
    expect(events.map((e) => e.type).sort()).toEqual(["created", "merged"]);
    // Only the created lead is queued for assignment.
    expect(enqueued.filter((e) => e.job === "assign-lead")).toHaveLength(1);
  });

  it("the same phone in another tenant is a separate lead", async () => {
    const pa = await seedProcess(A);
    const pb = await seedProcess(B);
    const lead = { phoneKey: "9822222222", custom: {} };
    const a = await createOrMergeLead(A, pa, lead, { kind: "web_form" });
    const b = await createOrMergeLead(B, pb, lead, { kind: "web_form" });
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");
  });
});

// ---------------------------------------------------------------------------
describe("auto-assignment", () => {
  it("percentage method interleaves 50/30/20 and updates open_leads atomically", async () => {
    const process = await seedProcess(A, "percentage");
    const a = await seedAgent(A, process.id, { shareWeight: 50, name: "A" });
    const b = await seedAgent(A, process.id, { shareWeight: 30, name: "B" });
    const c = await seedAgent(A, process.id, { shareWeight: 20, name: "C" });

    const picks: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { leadId } = await createOrMergeLead(A, process, { phoneKey: `97000000${String(i).padStart(2, "0")}`, custom: {} }, { kind: "csv" });
      const res = await assignLead(A, leadId, new Date("2026-10-01T06:00:00Z"));
      if (res.outcome === "assigned") picks.push(res.userId);
    }
    const count = (id: string) => picks.filter((p) => p === id).length;
    expect([count(a.id), count(b.id), count(c.id)]).toEqual([5, 3, 2]);

    const agents = await withTenant(A, (tx) => tx.select({ id: s.users.id, open: s.users.openLeads }).from(s.users).where(eq(s.users.id, a.id)));
    expect(agents[0]!.open).toBe(5);
  });

  it("never exceeds max_open_leads and skips agents who are full", async () => {
    const process = await seedProcess(A, "equal");
    const small = await seedAgent(A, process.id, { maxOpenLeads: 1, name: "Small" });
    const big = await seedAgent(A, process.id, { maxOpenLeads: 10, name: "Big" });

    const owners: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { leadId } = await createOrMergeLead(A, process, { phoneKey: `96000000${i}0`, custom: {} }, { kind: "csv" });
      const res = await assignLead(A, leadId);
      if (res.outcome === "assigned") owners.push(res.userId);
    }
    expect(owners.filter((o) => o === small.id)).toHaveLength(1);
    expect(owners.filter((o) => o === big.id)).toHaveLength(3);
  });

  it("is idempotent: assigning the same lead twice does nothing the second time", async () => {
    const process = await seedProcess(A);
    await seedAgent(A, process.id);
    const { leadId } = await createOrMergeLead(A, process, { phoneKey: "9500000001", custom: {} }, { kind: "csv" });
    expect((await assignLead(A, leadId)).outcome).toBe("assigned");
    expect((await assignLead(A, leadId)).outcome).toBe("already_assigned");
  });

  it("leaves the lead unassigned when nobody is eligible", async () => {
    const process = await seedProcess(A);
    await seedAgent(A, process.id, { isAvailable: false });
    const { leadId } = await createOrMergeLead(A, process, { phoneKey: "9500000002", custom: {} }, { kind: "csv" });
    expect((await assignLead(A, leadId)).outcome).toBe("no_eligible_agent");
  });
});

// ---------------------------------------------------------------------------
describe("telephony: click-to-call webhooks (no SIP)", () => {
  // One CallerDesk integration per tenant (unique index), reused across tests.
  const seeded = new Map<string, Promise<{ process: s.Process; integration: s.Integration }>>();
  function seedTelephony(ctx: TenantContext) {
    if (!seeded.has(ctx.tenantId)) seeded.set(ctx.tenantId, createTelephony(ctx));
    return seeded.get(ctx.tenantId)!;
  }
  async function createTelephony(ctx: TenantContext) {
    const process = await seedProcess(ctx);
    const integration = await withTenant(ctx, async (tx) => {
      const [i] = await tx.insert(s.integrations).values({ kind: "telephony", provider: "callerdesk", credentialsEnc: "x" }).returning();
      await tx.insert(s.telephonyDids).values({ integrationId: i!.id, number: "07971544878", number10: "7971544878", processId: process.id, direction: "both" });
      return i!;
    });
    return { process, integration };
  }

  it("outbound: initiated → answered → completed, counts one attempt, emits call.completed", async () => {
    const { process, integration } = await seedTelephony(B);
    const agent = await seedAgent(B, process.id, { agentPhone10: "9000000001", agentPhoneE164: "+919000000001" });
    const { leadId } = await createOrMergeLead(B, process, { phoneKey: "9811112222", phoneE164: "+919811112222", custom: {} }, { kind: "manual" });
    const correlationId = crypto.randomUUID();
    await withTenant(B, (tx) =>
      tx.insert(s.interactions).values({
        type: "call", direction: "outbound", leadId, processId: process.id, agentId: agent.id, status: "initiated",
        provider: "callerdesk", correlationId, did: "07971544878", agentNumber: "9000000001", customerNumber: "+919811112222",
      }),
    );
    const base = { direction: "outbound" as const, correlationId, did: "07971544878", customerNumber: "9811112222", agentNumber: "9000000001", at: new Date() };

    await applyCallEvents(B, integration, [
      { ...base, kind: "agent_ringing" },
      { ...base, kind: "answered" },
      { ...base, kind: "answered" }, // duplicate webhook — ignored
      { ...base, kind: "completed", durationSec: 95 },
      { ...base, kind: "customer_ringing" }, // late, out of order — ignored
    ]);

    const [call] = await withTenant(B, (tx) => tx.select().from(s.interactions).where(eq(s.interactions.correlationId, correlationId)));
    expect(call).toMatchObject({ status: "completed", durationSec: 95 });
    const [lead] = await withTenant(B, (tx) => tx.select({ attempts: s.leads.attempts }).from(s.leads).where(eq(s.leads.id, leadId)));
    expect(lead!.attempts).toBe(1);
    const events = await withTenant(B, (tx) => tx.select({ t: s.outbox.eventType }).from(s.outbox).where(eq(s.outbox.entityId, call!.id)));
    expect(events.map((e) => e.t)).toEqual(["call.completed"]);
  });

  it("outbound with CallerDesk's documented Call Report: matched by campid, completed with talk time", async () => {
    const { callerDeskAdapter } = await import("@/lib/providers/telephony/callerdesk/adapter");
    const { process, integration } = await seedTelephony(B);
    const agent = await seedAgent(B, process.id, { agentPhone10: "9000000002", agentPhoneE164: "+919000000002" });
    const { leadId } = await createOrMergeLead(B, process, { phoneKey: "9811113333", phoneE164: "+919811113333", custom: {} }, { kind: "manual" });
    const correlationId = crypto.randomUUID();
    await withTenant(B, (tx) =>
      tx.insert(s.interactions).values({
        type: "call", direction: "outbound", leadId, processId: process.id, agentId: agent.id, status: "initiated",
        provider: "callerdesk", providerCallId: "8397411", correlationId, did: "07971544878", agentNumber: "9000000002", customerNumber: "+919811113333",
      }),
    );
    // Exactly the documented payload shape (numbers changed): Source = agent, DialWhom = customer.
    const events = callerDeskAdapter.parseWebhook(
      {
        type: "call_report", SourceNumber: "09000000002", DestinationNumber: "07971544878", DialWhomNumber: "09811113333",
        CallDuration: "26", Status: "ANSWER", StartTime: "2024-12-30 12:43:19", EndTime: "2024-12-30 12:43:45", CallSid: "8397472",
        Direction: "WEBOBD", campid: "8397411", TalkDuration: "14", LegA_Picked_time: "2024-12-30 12:43:27", LegB_Picked_time: "2024-12-30 12:43:31",
        hangup_cause: "ANSWER(16-customer)",
      },
      { registeredDids: ["07971544878"] },
    );
    await applyCallEvents(B, integration, events);
    const [call] = await withTenant(B, (tx) => tx.select().from(s.interactions).where(eq(s.interactions.correlationId, correlationId)));
    expect(call).toMatchObject({ status: "completed", durationSec: 26 });
  });

  it("inbound missed call: creates lead + missed call + ONE callback per lead per day", async () => {
    const { integration } = await seedTelephony(A);
    const at = new Date("2026-10-01T06:00:00Z");
    const missed = (id: string) => ({ kind: "missed" as const, direction: "inbound" as const, providerCallId: id, did: "07971544878", customerNumber: "9812345678", at });

    await applyCallEvents(A, integration, [missed("cd-1")]);
    await applyCallEvents(A, integration, [missed("cd-2")]); // same caller calls again, same day

    const calls = await withTenant(A, (tx) =>
      tx.select({ status: s.interactions.status }).from(s.interactions).where(and(eq(s.interactions.direction, "inbound"), eq(s.interactions.customerNumber, "+919812345678"))),
    );
    expect(calls).toEqual([{ status: "missed" }, { status: "missed" }]);

    const cbs = await withTenant(A, (tx) => tx.select().from(s.callbacks).where(eq(s.callbacks.reason, "missed_call")));
    expect(cbs).toHaveLength(1);
  });

  it("inbound call on an unmapped DID fails loudly instead of guessing", async () => {
    const { integration } = await seedTelephony(A);
    await expect(
      applyCallEvents(A, integration, [{ kind: "answered", direction: "inbound", providerCallId: "x9", did: "08000000000", customerNumber: "9812340000", at: new Date() }]),
    ).rejects.toThrow(/unmapped DID/);
  });
});

// ---------------------------------------------------------------------------
describe("webhook intake", () => {
  it("stores once and queues once for a provider retry of the same body", async () => {
    const first = await receiveWebhook({ ctx: A, source: "telephony:callerdesk", payload: { a: 1 }, rawBody: '{"a":1}' });
    const second = await receiveWebhook({ ctx: A, source: "telephony:callerdesk", payload: { a: 1 }, rawBody: '{"a":1}' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(enqueued.filter((e) => e.job === "process-webhook")).toHaveLength(1);
  });

  it("call webhooks (processNow) are processed at once, and only a failure goes to the queue", async () => {
    const before = enqueued.length;
    // Not a CallerDesk event (no status) → nothing to apply → done, no queue message.
    await receiveWebhook({ ctx: A, source: "telephony:callerdesk", payload: { b: 1 }, rawBody: '{"b":1}', processNow: true });
    const rows = await withTenant(A, (tx) => tx.select().from(s.webhookEvents).where(sql`${s.webhookEvents.payload}->>'b' = '1'`));
    expect(rows.map((r) => r.status)).toEqual(["done"]);
    expect(enqueued.length).toBe(before);
    // Unknown provider → processing fails → queued for QStash retries.
    await receiveWebhook({ ctx: A, source: "telephony:nope", payload: { c: 1 }, rawBody: '{"c":1}', processNow: true });
    expect(enqueued.slice(before).map((e) => e.job)).toEqual(["process-webhook"]);
  });
});

// Sanity: the app role really cannot bypass RLS.
describe("app_rls role", () => {
  it("has no BYPASSRLS", async () => {
    const res = await db.execute(sql`select rolbypassrls from pg_roles where rolname = 'app_rls'`);
    expect((res.rows[0] as { rolbypassrls: boolean }).rolbypassrls).toBe(false);
  });
});
