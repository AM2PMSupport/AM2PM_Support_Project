/**
 * Floor report + callback reminders on real Postgres (PGlite, real RLS).
 *
 *   getFloor: today's KPIs, a funnel that never widens, process scoping
 *             for managers, Redis presence over DB availability.
 *   runCallbackReminders: due-soon reminder once, overdue → missed +
 *             supervisors notified + callback.missed event, SLA alert —
 *             and a second run changes nothing (idempotent).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";

const presence = new Map<string, string>();
vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));
vi.mock("@/lib/redis/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/redis/client")>()),
  redis: () => ({ mget: async (...keys: string[]) => keys.map((k) => presence.get(k) ?? null) }),
}));
const { getFloor } = await import("@/lib/reports/floor");
const { runCallbackReminders } = await import("@/lib/platform-admin/reminders");
const { keys } = await import("@/lib/redis/client");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let manager: SessionContext;
let agent: SessionContext;
let procA: string;
let procB: string;

async function lead(processId: string, opts: Partial<typeof s.leads.$inferInsert> = {}) {
  return withTenant(admin, async (tx) => {
    const [c] = await tx.insert(s.contacts).values({ name: "L", phoneE164: "+915500000001", phoneKey: crypto.randomUUID().slice(0, 10) }).returning();
    const [l] = await tx
      .insert(s.leads)
      .values({ processId, contactId: c!.id, source: { kind: "web_form" }, stage: "New", dedupeKey: crypto.randomUUID(), ...opts })
      .returning();
    return l!;
  });
}

const notesFor = (ctx: SessionContext) => withTenant(ctx, (tx) => tx.select().from(s.notifications).where(eq(s.notifications.userId, ctx.actor.userId)));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "reports-t");
  const mk = async (email: string, role: Role): Promise<SessionContext> => {
    const ctx = { ...t, actor: { userId: "", role, name: email } };
    const [u] = await withTenant(ctx, (tx) => tx.insert(s.users).values({ email, name: email, role, isAvailable: true }).returning());
    return { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug, actor: { userId: u!.id, role, name: email } };
  };
  admin = await mk("admin@x.test", "admin");
  manager = await mk("mgr@x.test", "manager");
  agent = await mk("agent@x.test", "agent");
  await withTenant(admin, async (tx) => {
    const mkP = async (name: string) =>
      (await tx.insert(s.processes).values({ name, stages: ["New", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning())[0]!.id;
    procA = await mkP("A");
    procB = await mkP("B");
    // Manager and agent work process A only.
    await tx.insert(s.userProcesses).values([
      { userId: manager.actor.userId, processId: procA },
      { userId: agent.actor.userId, processId: procA },
    ]);
  });

  // Process A today: 3 leads → 1 answered call + won, 1 interested (no call), 1 untouched.
  const won = await lead(procA, { assignedTo: agent.actor.userId, status: "won", convertedAt: new Date() });
  await lead(procA, { assignedTo: agent.actor.userId, lastDisposition: { code: "INTERESTED", label: "Interested", category: "positive", at: new Date().toISOString() } });
  await lead(procA, { assignedTo: agent.actor.userId });
  await withTenant(admin, (tx) =>
    tx.insert(s.interactions).values({ type: "call", direction: "outbound", leadId: won.id, processId: procA, agentId: agent.actor.userId, status: "completed", durationSec: 120 }),
  );
  // Process B today: 2 leads, invisible to the manager.
  await lead(procB);
  await lead(procB);
}, 60_000);
afterAll(async () => close());

describe("getFloor", () => {
  it("admin sees the whole workspace; the funnel never widens", async () => {
    const f = await getFloor(admin);
    expect(f.kpis.leadsToday).toBe(5);
    expect(f.kpis).toMatchObject({ attempted: 1, connected: 1, conversions: 1, avgTalkSec: 120 });
    expect(f.funnel.map((x) => x.count)).toEqual([5, 3, 2, 2, 1]);
    for (let i = 1; i < f.funnel.length; i++) expect(f.funnel[i]!.count).toBeLessThanOrEqual(f.funnel[i - 1]!.count);
    expect(f.byHour).toHaveLength(12);
  });

  it("manager sees only their processes", async () => {
    const f = await getFloor(manager);
    expect(f.kpis.leadsToday).toBe(3);
    expect(f.kpis.unassigned).toBe(0);
    expect(f.agents.map((a) => a.name)).toEqual(["agent@x.test"]);
    expect((await getFloor(admin)).kpis.unassigned).toBe(2);
  });

  it("agent status comes from Redis presence, else DB availability", async () => {
    expect((await getFloor(manager)).agents[0]!.status).toBe("available");
    presence.set(keys.presence(agent.tenantId, agent.actor.userId), "on_call");
    expect((await getFloor(manager)).agents[0]!.status).toBe("on_call");
    presence.clear();
  });
});

describe("runCallbackReminders", () => {
  it("reminds once, escalates overdue callbacks to supervisors, alerts on SLA; idempotent", async () => {
    const now = new Date();
    const l1 = await lead(procA, { assignedTo: agent.actor.userId });
    const l2 = await lead(procA, { assignedTo: agent.actor.userId });
    const [soon, late] = await withTenant(admin, (tx) =>
      tx
        .insert(s.callbacks)
        .values([
          { leadId: l1.id, assignedTo: agent.actor.userId, dueAt: new Date(now.getTime() + 10 * 60_000), reason: "agent" },
          { leadId: l2.id, assignedTo: agent.actor.userId, dueAt: new Date(now.getTime() - 45 * 60_000), reason: "agent" },
        ])
        .returning(),
    );
    // An unassigned lead older than the 15-minute SLA.
    await lead(procA, { createdAt: new Date(now.getTime() - 60 * 60_000) });

    const r = await runCallbackReminders(now);
    expect(r.reminded).toBe(1);
    expect(r.missed).toBe(1);
    expect(r.slaAlerts).toBeGreaterThanOrEqual(1);

    const cbs = await withTenant(admin, (tx) => tx.select().from(s.callbacks));
    expect(cbs.find((c) => c.id === soon!.id)).toMatchObject({ status: "pending" });
    expect(cbs.find((c) => c.id === soon!.id)!.remindedAt).not.toBeNull();
    expect(cbs.find((c) => c.id === late!.id)).toMatchObject({ status: "missed" });

    const agentNotes = await notesFor(agent);
    expect(agentNotes.map((n) => n.kind).sort()).toEqual(["callback_due", "callback_missed"]);
    const mgrNotes = await notesFor(manager);
    expect(mgrNotes.some((n) => n.kind === "callback_missed")).toBe(true);
    expect(mgrNotes.some((n) => n.kind === "sla_breach")).toBe(true);

    const events = await withTenant(admin, (tx) => tx.select().from(s.outbox).where(eq(s.outbox.eventType, "callback.missed")));
    expect(events).toHaveLength(1);

    // Second run: nothing new is reminded, missed, or duplicated.
    const r2 = await runCallbackReminders(now);
    expect(r2).toMatchObject({ reminded: 0, missed: 0 });
    expect(await notesFor(agent)).toHaveLength(agentNotes.length);
    expect(await notesFor(manager)).toHaveLength(mgrNotes.length);
  });
});
