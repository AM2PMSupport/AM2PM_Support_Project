/**
 * Reports module (lib/reports/reports.ts) on real Postgres (PGlite, real RLS):
 * one known day of leads, calls, callbacks and logins, then every report's
 * numbers, the agent day sheet (login, first/last call, per-hour, callback
 * compliance), scope (agent = own numbers, other workspace = nothing) and a
 * foreign process filter → 404.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";
import { localToday, resolveRange, summariseAgents } from "@/lib/reports/period";

vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));
const { agentDays, callsReport, overviewReport, reportScope, sourcesReport } = await import("@/lib/reports/reports");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let agentA: SessionContext;
let agentB: SessionContext;
let other: SessionContext;
let processId: string;
// Yesterday in the workspace (IST), so every row is in the past and on one local day.
const D = resolveRange({ period: "yesterday" }, localToday("Asia/Kolkata")).from;
const at = (hhmm: string) => new Date(`${D}T${hhmm}:00+05:30`);

async function mk(t: Awaited<ReturnType<typeof seedTenant>>, email: string, role: Role): Promise<SessionContext> {
  const base = { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug };
  const [u] = await withTenant({ ...base, actor: { userId: "", role, name: email } }, (tx) => tx.insert(s.users).values({ email, name: email, role, maxOpenLeads: 100 }).returning());
  return { ...base, actor: { userId: u!.id, role, name: email } };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "rep-t");
  admin = await mk(t, "admin@r.test", "admin");
  agentA = await mk(t, "asha@r.test", "agent");
  agentB = await mk(t, "bala@r.test", "agent");
  other = await mk(await seedTenant(db, "rep-other"), "admin@o.test", "admin");
  await withTenant(admin, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "Sales", stages: ["New", "Hot", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    processId = p!.id;
    await tx.insert(s.userProcesses).values([{ userId: agentA.actor.userId, processId }, { userId: agentB.actor.userId, processId }]);
    const lead = async (i: number, kind: s.LeadSourceInfo["kind"], owner: string, extra: Partial<typeof s.leads.$inferInsert> = {}) => {
      const [c] = await tx.insert(s.contacts).values({ name: `R${i}`, phoneE164: `+91970000000${i}`, phoneKey: `970000000${i}` }).returning();
      const [l] = await tx.insert(s.leads).values({ processId, contactId: c!.id, source: { kind }, stage: "New", dedupeKey: `970000000${i}`, assignedTo: owner, createdAt: at("09:00"), ...extra }).returning();
      return l!.id;
    };
    // A: 3 leads (2 meta, 1 web); one won, one lost. B: 1 lead, never called.
    const l1 = await lead(1, "meta_ads", agentA.actor.userId, { status: "won", stage: "Won", convertedAt: at("15:00"), lastDisposition: { code: "won", label: "Sale", category: "converted", at: at("15:00").toISOString() } });
    const l2 = await lead(2, "meta_ads", agentA.actor.userId, { status: "lost", lastDisposition: { code: "ni", label: "Not interested", category: "negative", at: at("12:02").toISOString() } });
    const l3 = await lead(3, "web_form", agentA.actor.userId);
    await lead(4, "web_form", agentB.actor.userId);
    const call = (leadId: string, start: string, end: string, status: string, extra: Partial<typeof s.interactions.$inferInsert> = {}) =>
      ({ leadId, processId, agentId: agentA.actor.userId, type: "call" as const, direction: "outbound" as const, status, startedAt: at(start), endedAt: at(end), ...extra });
    await tx.insert(s.interactions).values([
      call(l1, "10:00", "10:05", "completed", { talkSec: 300, disposition: { code: "won", label: "Sale", category: "converted" } }),
      call(l2, "11:00", "11:01", "no_answer"),
      call(l2, "12:00", "12:02", "completed", { talkSec: 120, disposition: { code: "ni", label: "Not interested", category: "negative" } }),
      call(l3, "13:00", "14:00", "completed", { talkSec: 60, disposition: { code: "cb", label: "Call back", category: "callback" } }),
      call(l3, "13:30", "13:31", "missed", { direction: "inbound" }),
    ]);
    // Callbacks for A: one called on time (due 12:55, called 13:00), one never called.
    await tx.insert(s.callbacks).values([
      { leadId: l3, assignedTo: agentA.actor.userId, dueAt: at("12:55"), status: "done", reason: "agent" },
      { leadId: l1, assignedTo: agentA.actor.userId, dueAt: at("16:00"), status: "missed", reason: "agent" },
    ]);
    await tx.insert(s.auditLogs).values([
      { actorId: agentA.actor.userId, action: "auth.login", entity: "user", createdAt: at("09:30") },
      { actorId: agentA.actor.userId, action: "auth.logout", entity: "user", createdAt: at("18:00") },
      { actorId: agentB.actor.userId, action: "auth.login", entity: "user", createdAt: at("09:45") },
    ]);
  });
}, 60_000);
afterAll(async () => close());

const scopeOf = async (ctx: SessionContext, q: Record<string, string> = {}) => ({ ctx, ...(await reportScope(ctx, { period: "custom", from: D, to: D, ...q })) });

describe("reports module", () => {
  it("overview: funnel, outcomes and speed for leads created in the range", async () => {
    const o = await overviewReport(await scopeOf(admin));
    // First calls came 1 h, 2 h and 4 h after the leads → median 2 h.
    expect(o.kpis).toMatchObject({ leadsIn: 4, attempted: 3, reached: 3, won: 1, lost: 1, neverCalled: 1, medianFirstCallSec: 2 * 3600 });
    const counts = o.funnel.map((f) => f.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a)); // never widens
    expect(o.trend).toEqual([{ day: D, leadsIn: 4, won: 1 }]);
    expect(o.lostReasons).toEqual([{ reason: "Not interested", count: 1 }]);
  });

  it("sources: per channel", async () => {
    const rows = await sourcesReport(await scopeOf(admin));
    expect(rows.find((r) => r.source === "meta_ads")).toMatchObject({ leads: 2, attempted: 2, reached: 2, won: 1, lost: 1 });
    expect(rows.find((r) => r.source === "web_form")).toMatchObject({ leads: 2, attempted: 1, neverCalled: 1 });
  });

  it("calls: volume, results, callback compliance", async () => {
    const c = await callsReport(await scopeOf(admin));
    expect(c.kpis).toMatchObject({ dialled: 4, connected: 3, inbound: 1, inboundMissed: 1, talkSec: 480, avgTalkSec: 160 });
    expect(c.byHour[10]).toEqual({ hour: 10, attempted: 1, connected: 1 });
    expect(c.callbacks).toMatchObject({ due: 2, onTime: 1, notCalled: 1 });
    expect(c.outcomes.map((o) => o.label).sort()).toEqual(["Call back", "Not interested", "Sale"]);
  });

  it("agents: day sheet with login, first/last call, per hour and callbacks", async () => {
    const days = await agentDays(await scopeOf(admin));
    const a = days.find((d) => d.agentId === agentA.actor.userId)!;
    expect(a).toMatchObject({ day: D, dialled: 4, connected: 3, inboundMissed: 1, talkSec: 480, won: 1, interested: 0, callbacksSet: 1, notInterested: 1, callbacksDue: 2, callbacksOnTime: 1 });
    expect(a.login).toBe(at("09:30").getTime());
    expect(a.logout).toBe(at("18:00").getTime());
    expect(a.firstCall).toBe(at("10:00").getTime());
    expect(a.lastCall).toBe(at("14:00").getTime());
    expect(Math.round(a.firstCallMin!)).toBe(600);
    // B logged in but made no calls: still on the sheet.
    expect(days.find((d) => d.agentId === agentB.actor.userId)).toMatchObject({ dialled: 0, login: at("09:45").getTime() });
    const [sa] = summariseAgents(days);
    expect(sa).toMatchObject({ name: "asha@r.test", dialledPerHour: 1, connectRate: 0.75, callbackCompliance: 0.5 });
  });

  it("scope: an agent sees only their own numbers; another workspace sees nothing", async () => {
    const mine = await agentDays(await scopeOf(agentB));
    expect(mine.map((d) => d.agentId)).toEqual([agentB.actor.userId]);
    expect((await overviewReport(await scopeOf(agentB))).kpis.leadsIn).toBe(1);
    expect((await callsReport(await scopeOf(agentB))).kpis.dialled).toBe(0);
    expect((await overviewReport(await scopeOf(other))).kpis.leadsIn).toBe(0);
    expect(await agentDays(await scopeOf(other))).toEqual([]);
  });

  it("process filter: own process narrows, a foreign or garbage id is a 404", async () => {
    expect((await overviewReport(await scopeOf(admin, { process: processId }))).kpis.leadsIn).toBe(4);
    await expect(scopeOf(other, { process: processId })).rejects.toMatchObject({ status: 404 });
    await expect(scopeOf(admin, { process: "x' or 1=1" })).rejects.toMatchObject({ status: 404 });
  });
});
