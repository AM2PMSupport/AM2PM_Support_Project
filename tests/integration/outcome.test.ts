/**
 * Outcomes and stages on real Postgres: each disposition CATEGORY does the
 * right thing, capacity is released on close, events are emitted, and an
 * agent can only touch their own leads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";

vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));
const { saveOutcome, setStage } = await import("@/lib/agent/outcome");
const { getQueue, getLeadDetail } = await import("@/lib/agent/queue");
const { DEFAULT_DISPOSITIONS } = await import("@/lib/admin/processes");

let db: TestDb;
let close: () => Promise<void>;
let agent: SessionContext;
let otherAgent: SessionContext;
let processId: string;
const disp: Record<string, string> = {};

async function newLead(owner: SessionContext, name: string) {
  return withTenant(owner, async (tx) => {
    const [c] = await tx.insert(s.contacts).values({ name, phoneE164: "+915500000001", phoneKey: crypto.randomUUID().slice(0, 10) }).returning();
    const [l] = await tx
      .insert(s.leads)
      .values({ processId, contactId: c!.id, source: { kind: "manual" }, stage: "New", assignedTo: owner.actor.userId, dedupeKey: crypto.randomUUID() })
      .returning();
    await tx.update(s.users).set({ openLeads: 1 }).where(eq(s.users.id, owner.actor.userId));
    return l!.id;
  });
}

const openLeads = (ctx: SessionContext) =>
  withTenant(ctx, async (tx) => (await tx.select({ n: s.users.openLeads }).from(s.users).where(eq(s.users.id, ctx.actor.userId)))[0]!.n);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "outcome-t");
  const mk = async (email: string): Promise<SessionContext> => {
    const ctx = { ...t, actor: { userId: "", role: "agent" as const, name: email } };
    const [u] = await withTenant(ctx, (tx) => tx.insert(s.users).values({ email, name: email, role: "agent" }).returning());
    return { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug, actor: { userId: u!.id, role: "agent", name: email } };
  };
  agent = await mk("a@x.test");
  otherAgent = await mk("b@x.test");
  await withTenant(agent, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "P", stages: ["New", "Hot", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    processId = p!.id;
    const ds = await tx.insert(s.dispositions).values(DEFAULT_DISPOSITIONS.map((d, i) => ({ ...d, processId, sortOrder: i }))).returning();
    for (const d of ds) disp[d.code] = d.id;
  });
}, 60_000);
afterAll(async () => close());

describe("saveOutcome", () => {
  it("callback: creates a pending callback and sets next_callback_at", async () => {
    const leadId = await newLead(agent, "Cb");
    const at = new Date(Date.now() + 3600_000).toISOString();
    await saveOutcome(agent, { leadId, dispositionId: disp.CALL_BACK!, note: "", callbackAt: at });
    const [cb] = await withTenant(agent, (tx) => tx.select().from(s.callbacks).where(eq(s.callbacks.leadId, leadId)));
    expect(cb).toMatchObject({ status: "pending", reason: "agent" });
    const d = await getLeadDetail(agent, leadId);
    expect(d.nextCallbackAt).toBe(new Date(at).toISOString());
    expect(d.timeline.some((t) => t.title === "Outcome: Call back")).toBe(true);
  });

  it("callback needs a time", async () => {
    const leadId = await newLead(agent, "NoTime");
    await expect(saveOutcome(agent, { leadId, dispositionId: disp.CALL_BACK!, note: "" })).rejects.toThrow(/callback time/);
  });

  it("converted: won + won stage + capacity released + lead.converted event", async () => {
    const leadId = await newLead(agent, "Win");
    await saveOutcome(agent, { leadId, dispositionId: disp.CONVERTED!, note: "paid" });
    const [l] = await withTenant(agent, (tx) => tx.select().from(s.leads).where(eq(s.leads.id, leadId)));
    expect(l).toMatchObject({ status: "won", stage: "Won" });
    expect(l!.convertedAt).toBeInstanceOf(Date);
    expect(await openLeads(agent)).toBe(0);
    const events = await withTenant(agent, (tx) => tx.select({ t: s.outbox.eventType }).from(s.outbox).where(eq(s.outbox.entityId, leadId)));
    expect(events.map((e) => e.t).sort()).toEqual(["disposition.set", "lead.converted"]);
  });

  it("dnc: closes the lead and flags the contact Do Not Call", async () => {
    const leadId = await newLead(agent, "Dnc");
    await saveOutcome(agent, { leadId, dispositionId: disp.DNC!, note: "" });
    const [row] = await withTenant(agent, (tx) =>
      tx.select({ status: s.leads.status, dnc: s.contacts.dnc }).from(s.leads).innerJoin(s.contacts, eq(s.contacts.id, s.leads.contactId)).where(eq(s.leads.id, leadId)),
    );
    expect(row).toEqual({ status: "dnc", dnc: true });
  });

  it("negative: lost; a second outcome on a closed lead is refused", async () => {
    const leadId = await newLead(agent, "Lost");
    await saveOutcome(agent, { leadId, dispositionId: disp.NOT_INTERESTED!, note: "" });
    await expect(saveOutcome(agent, { leadId, dispositionId: disp.INTERESTED!, note: "" })).rejects.toThrow(/closed/);
  });

  it("an agent cannot touch another agent's lead", async () => {
    const leadId = await newLead(otherAgent, "NotMine");
    await expect(saveOutcome(agent, { leadId, dispositionId: disp.INTERESTED!, note: "" })).rejects.toThrow(/not found/i);
    expect((await getQueue(agent)).some((q) => q.id === leadId)).toBe(false);
  });
});

describe("setStage", () => {
  it("moves stages and converts on the won stage", async () => {
    const leadId = await newLead(agent, "Stage");
    await setStage(agent, { leadId, stage: "Hot" });
    await setStage(agent, { leadId, stage: "Won" });
    const [l] = await withTenant(agent, (tx) => tx.select().from(s.leads).where(and(eq(s.leads.id, leadId))));
    expect(l).toMatchObject({ stage: "Won", status: "won" });
  });

  it("masks phones for agents in the queue", async () => {
    await newLead(agent, "Masked");
    const q = await getQueue(agent);
    expect(q.every((i) => i.phone.includes("XXXXXX"))).toBe(true);
  });
});
