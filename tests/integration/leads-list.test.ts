/**
 * Leads screen on real Postgres (RLS): filters, keyset paging in every sort
 * order (no duplicates, no gaps), totals, bulk reassign bookkeeping
 * (open_leads, callbacks follow, events), saved-filter privacy, Create Lead
 * dedupe, and an agent seeing only their own leads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";

vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));
vi.mock("@/lib/redis/client", async (importOriginal) => {
  const { fakeRedis } = await import("../helpers/db");
  const r = fakeRedis();
  return { ...(await importOriginal<typeof import("@/lib/redis/client")>()), redis: () => r };
});
const { listLeads, leadFilterOptions, SORTS } = await import("@/lib/leads/list");
const { bulkAssign, bulkStage } = await import("@/lib/leads/bulk");
const { saveView, listViews, deleteView } = await import("@/lib/leads/views");
const { createManualLead } = await import("@/lib/leads/manual");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let agentA: SessionContext;
let agentB: SessionContext;
let other: SessionContext;
let processId: string;
const ids: string[] = [];

async function mk(t: Awaited<ReturnType<typeof seedTenant>>, email: string, role: Role): Promise<SessionContext> {
  const base = { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug };
  const [u] = await withTenant({ ...base, actor: { userId: "", role, name: email } }, (tx) => tx.insert(s.users).values({ email, name: email, role, maxOpenLeads: 100 }).returning());
  return { ...base, actor: { userId: u!.id, role, name: email } };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "list-t");
  admin = await mk(t, "admin@x.test", "admin");
  agentA = await mk(t, "a@x.test", "agent");
  agentB = await mk(t, "b@x.test", "agent");
  other = await mk(await seedTenant(db, "list-other"), "admin@other.test", "admin");
  await withTenant(admin, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "Sales", stages: ["New", "Hot", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    processId = p!.id;
    await tx.insert(s.userProcesses).values([{ userId: agentA.actor.userId, processId }, { userId: agentB.actor.userId, processId }]);
    // 23 leads; same created_at for some rows to exercise the id tie-breaker.
    const sameTime = new Date(Date.now() - 3600_000);
    for (let i = 0; i < 23; i++) {
      const [c] = await tx.insert(s.contacts).values({ name: `Lead ${String.fromCharCode(65 + (i % 26))}${i}`, phoneE164: `+9198${String(i).padStart(8, "0")}`, phoneKey: `98${String(i).padStart(8, "0")}` }).returning();
      const [l] = await tx
        .insert(s.leads)
        .values({
          processId,
          contactId: c!.id,
          source: { kind: i % 3 === 0 ? "meta_ads" : "web_form" },
          stage: i % 4 === 0 ? "Hot" : "New",
          dedupeKey: `98${String(i).padStart(8, "0")}`,
          assignedTo: i < 10 ? agentA.actor.userId : null,
          createdAt: i % 5 === 0 ? sameTime : new Date(Date.now() - i * 60_000),
          nextCallbackAt: i % 2 ? new Date(Date.now() + i * 600_000) : null,
        })
        .returning();
      ids.push(l!.id);
    }
    await tx.update(s.users).set({ openLeads: 10 }).where(eq(s.users.id, agentA.actor.userId));
    await tx.insert(s.callbacks).values({ leadId: ids[0]!, assignedTo: agentA.actor.userId, dueAt: new Date(Date.now() - 60_000), reason: "agent" });
  });
}, 60_000);
afterAll(async () => close());

describe("listLeads", () => {
  it("filters: unassigned, source, stage, overdue callback — with totals", async () => {
    expect((await listLeads(admin, { flag: "unassigned" })).total).toBe(13);
    expect((await listLeads(admin, { source: "meta_ads" })).total).toBe(8);
    expect((await listLeads(admin, { stage: "Hot" })).total).toBe(6);
    expect((await listLeads(admin, { stage: "Hot", source: "meta_ads" })).total).toBe(2);
    const overdue = await listLeads(admin, { flag: "callback_overdue" });
    expect(overdue.items.map((r) => r.id)).toEqual([ids[0]]);
  });

  it.each(SORTS)("keyset paging (%s): every lead exactly once", async (sort) => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listLeads(admin, { sort, limit: 5, cursor });
      expect(page.items.length).toBeLessThanOrEqual(5);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });

  it("an agent sees only their own leads; another workspace sees none", async () => {
    expect((await listLeads(agentA, {})).total).toBe(10);
    expect((await listLeads(agentB, {})).total).toBe(0);
    expect((await listLeads(other, {})).total).toBe(0);
    const opts = await leadFilterOptions(admin);
    expect(opts.owners.find((o) => o.id === agentA.actor.userId)?.n).toBe(10);
  });
});

describe("bulk actions", () => {
  it("reassigns: counts move between owners, callbacks follow, events written, agents not on the process skipped", async () => {
    const pick = [ids[0]!, ids[1]!, ids[12]!]; // two from A, one unassigned
    const r = await bulkAssign(admin, { leadIds: pick, ownerId: agentB.actor.userId });
    expect(r).toEqual({ moved: 3, skipped: 0 });
    const [a] = await db.select({ n: s.users.openLeads }).from(s.users).where(eq(s.users.id, agentA.actor.userId));
    const [b] = await db.select({ n: s.users.openLeads }).from(s.users).where(eq(s.users.id, agentB.actor.userId));
    expect(a!.n).toBe(8);
    expect(b!.n).toBe(3);
    const [cb] = await db.select().from(s.callbacks).where(eq(s.callbacks.leadId, ids[0]!));
    expect(cb!.assignedTo).toBe(agentB.actor.userId);
    const ev = await db.select().from(s.leadEvents).where(eq(s.leadEvents.leadId, ids[12]!));
    expect(ev.map((e) => e.type)).toContain("assigned");
  });

  it("agents can't bulk-assign", async () => {
    await expect(bulkAssign(agentA, { leadIds: [ids[2]!], ownerId: agentA.actor.userId })).rejects.toThrow(/permission/);
  });

  it("moves stage; unknown stage is skipped", async () => {
    expect(await bulkStage(admin, { leadIds: [ids[3]!, ids[5]!], stage: "Hot" })).toEqual({ moved: 2, skipped: 0 });
    expect(await bulkStage(admin, { leadIds: [ids[3]!], stage: "Nope" })).toEqual({ moved: 0, skipped: 1 });
  });
});

describe("saved filters", () => {
  it("personal filters are private; shared ones are visible to all; params are validated", async () => {
    await saveView(agentA, { name: "Mine overdue", query: { flag: "callback_overdue", cursor: "x" }, shared: false });
    await saveView(admin, { name: "Meta", query: { source: "meta_ads" }, shared: true });
    const forA = await listViews(agentA);
    expect(forA.map((v) => v.name).sort()).toEqual(["Meta", "Mine overdue"]);
    expect(forA.find((v) => v.name === "Mine overdue")!.query).toEqual({ flag: "callback_overdue" }); // cursor dropped
    expect((await listViews(agentB)).map((v) => v.name)).toEqual(["Meta"]);
    expect(await listViews(other)).toEqual([]);
    await expect(saveView(agentA, { name: "Share", query: {}, shared: true })).rejects.toThrow(/admins/);
    const meta = (await listViews(agentA)).find((v) => v.name === "Meta")!;
    await expect(deleteView(agentA, meta.id)).rejects.toThrow(/own filters/);
  });
});

describe("Create Lead", () => {
  it("creates, and a second entry for the same number merges instead of duplicating", async () => {
    const first = await createManualLead(admin, { processId, name: "Walk-in", phone: "+91 91234 56780", email: "", city: "Pune", note: "", ownerId: agentA.actor.userId });
    expect(first.outcome).toBe("created");
    const [l] = await db.select().from(s.leads).where(eq(s.leads.id, first.leadId));
    expect(l!.assignedTo).toBe(agentA.actor.userId);
    const again = await createManualLead(admin, { processId, name: "Walk-in again", phone: "9123456780", email: "", city: "", note: "" });
    expect(again).toEqual({ outcome: "merged", leadId: first.leadId });
    await expect(createManualLead(admin, { processId, name: "No contact", phone: "123", email: "", city: "", note: "" })).rejects.toThrow(/valid/);
  });
});

describe("paging backwards", () => {
  it("Prev returns exactly the pages Next produced, for every sort", async () => {
    const { listLeads: list } = await import("@/lib/leads/list");
    for (const sort of SORTS) {
      const forward: string[][] = [];
      let cursor: string | undefined;
      let last: Awaited<ReturnType<typeof list>> | undefined;
      do {
        last = await list(admin, { sort, limit: 5, cursor, status: "all" });
        forward.push(last.items.map((r) => r.id));
        cursor = last.nextCursor ?? undefined;
      } while (cursor);
      expect(last!.prevCursor).not.toBeNull();
      // Walk back from the last page.
      let before = last!.prevCursor ?? undefined;
      for (let i = forward.length - 2; i >= 0; i--) {
        const page = await list(admin, { sort, limit: 5, before, status: "all" });
        expect(page.items.map((r) => r.id)).toEqual(forward[i]);
        before = page.prevCursor ?? undefined;
      }
      expect(before).toBeUndefined(); // first page has no Prev
    }
  });
});

describe("edit, delete, restore", () => {
  const ed = () => import("@/lib/leads/edit");

  it("edits contact + custom fields; agents can't change the phone", async () => {
    const { updateLead, getLeadForEdit } = await ed();
    await updateLead(admin, { leadId: ids[4]!, name: "Renamed Lead", phone: "+91 97000 00004", email: "r@x.in", stage: "New", custom: { city: "Pune" } });
    const e = await getLeadForEdit(admin, ids[4]!);
    expect(e).toMatchObject({ name: "Renamed Lead", phone: "+919700000004", email: "r@x.in", canEditPhone: true });
    expect(e.custom.city).toBe("Pune");
    const [l] = await db.select().from(s.leads).where(eq(s.leads.id, ids[4]!));
    expect(l!.dedupeKey).toBe("9700000004");
    // An agent's edit keeps the phone even if one is sent.
    const own = (await listLeads(agentA, {})).items[0]!;
    const before = await getLeadForEdit(admin, own.id);
    await updateLead(agentA, { leadId: own.id, name: "Agent edit", phone: "9999999999", email: "", stage: before.stage });
    expect((await getLeadForEdit(admin, own.id)).phone).toBe(before.phone);
  });

  it("refuses an edit that would duplicate another open lead's number (and nothing is half-saved)", async () => {
    const { updateLead, getLeadForEdit } = await ed();
    const other = await getLeadForEdit(admin, ids[6]!);
    await expect(updateLead(admin, { leadId: ids[6]!, name: "Dup", phone: "9700000004", email: "", stage: other.stage })).rejects.toThrow(/already has this number/);
    expect((await getLeadForEdit(admin, ids[6]!)).name).toBe(other.name);
  });

  it("deletes to the recycle bin: hidden, capacity freed, callbacks cancelled; restore brings it back", async () => {
    const { deleteLeads, restoreLeads } = await ed();
    const [owner] = await db.select({ n: s.users.openLeads }).from(s.users).where(eq(s.users.id, agentB.actor.userId));
    await expect(deleteLeads(agentA, { leadIds: [ids[0]!] })).rejects.toThrow(/permission/);
    expect(await deleteLeads(admin, { leadIds: [ids[0]!] })).toEqual({ deleted: 1, skipped: 0 });
    expect((await listLeads(admin, { status: "all" })).items.some((r) => r.id === ids[0])).toBe(false);
    const bin = await listLeads(admin, { status: "deleted" });
    expect(bin.items.map((r) => r.id)).toEqual([ids[0]]);
    expect((await listLeads(agentB, { status: "deleted" })).total).toBe(0); // agents: no bin
    const [after] = await db.select({ n: s.users.openLeads }).from(s.users).where(eq(s.users.id, agentB.actor.userId));
    expect(after!.n).toBe(owner!.n - 1);
    const cbs = await db.select().from(s.callbacks).where(eq(s.callbacks.leadId, ids[0]!));
    expect(cbs.every((c) => c.status !== "pending")).toBe(true);

    expect(await restoreLeads(admin, { leadIds: [ids[0]!] })).toEqual({ restored: 1, skipped: 0 });
    expect((await listLeads(admin, { status: "deleted" })).total).toBe(0);
    const [back] = await db.select({ n: s.users.openLeads }).from(s.users).where(eq(s.users.id, agentB.actor.userId));
    expect(back!.n).toBe(owner!.n);
  });

  it("restore is skipped when a new open lead took the same number meanwhile", async () => {
    const { deleteLeads, restoreLeads } = await ed();
    await deleteLeads(admin, { leadIds: [ids[8]!] });
    await createManualLead(admin, { processId, name: "Came back", phone: "9800000008", email: "", city: "", note: "" });
    expect(await restoreLeads(admin, { leadIds: [ids[8]!] })).toEqual({ restored: 0, skipped: 1 });
  });
});

describe("edit keeps an unchanged legacy number", () => {
  it("saving the form with the same (non-mobile) number doesn't fail validation", async () => {
    const { updateLead, getLeadForEdit } = await import("@/lib/leads/edit");
    const [c] = await db.insert(s.contacts).values({ tenantId: admin.tenantId, name: "Legacy", phoneE164: "+915510012345", phoneKey: "5510012345" }).returning();
    const [l] = await db.insert(s.leads).values({ tenantId: admin.tenantId, processId, contactId: c!.id, source: { kind: "manual" }, stage: "New", dedupeKey: "5510012345" }).returning();
    const e = await getLeadForEdit(admin, l!.id);
    await updateLead(admin, { leadId: l!.id, name: "Legacy renamed", phone: e.phone, email: "", stage: "New" });
    expect((await getLeadForEdit(admin, l!.id)).name).toBe("Legacy renamed");
    await expect(updateLead(admin, { leadId: l!.id, name: "x", phone: "5510099999", email: "", stage: "New" })).rejects.toThrow(/valid 10-digit/);
  });
});

describe("console inline editing", () => {
  it("saves one field at a time; everything else stays as it was", async () => {
    const { updateLead, getLeadForEdit } = await import("@/lib/leads/edit");
    const id = ids[10]!;
    const before = await getLeadForEdit(admin, id);
    await updateLead(admin, { leadId: id, custom: { budget: "5L" } });
    await updateLead(admin, { leadId: id, campaign: "Diwali" });
    const after = await getLeadForEdit(admin, id);
    expect(after).toMatchObject({ name: before.name, phone: before.phone, email: before.email, stage: before.stage, campaign: "Diwali" });
    expect(after.custom.budget).toBe("5L");
    await updateLead(admin, { leadId: id, custom: { budget: "" } }); // clear
    expect((await getLeadForEdit(admin, id)).custom.budget).toBeUndefined();
  });

  it("an agent clears their own stuck call; other agents' calls are untouched", async () => {
    const { endMyStuckCall } = await import("@/lib/agent/outcome");
    const mkCall = (agentId: string) =>
      db.insert(s.interactions).values({ tenantId: admin.tenantId, type: "call", direction: "outbound", leadId: ids[11]!, processId, agentId, status: "initiated", correlationId: crypto.randomUUID() }).returning();
    const [mine] = await mkCall(agentA.actor.userId);
    const [theirs] = await mkCall(agentB.actor.userId);
    expect(await endMyStuckCall(agentA)).toEqual({ ended: 1 });
    const rows = await db.select().from(s.interactions).where(eq(s.interactions.leadId, ids[11]!));
    expect(rows.find((r) => r.id === mine!.id)).toMatchObject({ status: "unknown", endReason: "ended_by_agent" });
    expect(rows.find((r) => r.id === theirs!.id)!.status).toBe("initiated");
  });
});

describe("console process filter", () => {
  it("queue can be limited to processes (in SQL); process choices follow access", async () => {
    const { getQueue, myProcesses } = await import("@/lib/agent/queue");
    const other = await withTenant(admin, async (tx) => {
      const [p] = await tx.insert(s.processes).values({ name: "Zeta Support", stages: ["New"], wonStage: "New", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
      const [c] = await tx.insert(s.contacts).values({ name: "Zeta Lead", phoneE164: "+919700099999", phoneKey: "9700099999" }).returning();
      await tx.insert(s.leads).values({ processId: p!.id, contactId: c!.id, source: { kind: "manual" }, stage: "New", dedupeKey: "9700099999" });
      return p!.id;
    });
    const all = await getQueue(admin);
    expect(all.some((l) => l.processId === other)).toBe(true);
    const onlySales = await getQueue(admin, 150, { process: processId });
    expect(onlySales.length).toBeGreaterThan(0);
    expect(onlySales.every((l) => l.processId === processId)).toBe(true);
    expect((await getQueue(admin, 150, { process: other })).map((l) => l.name)).toEqual(["Zeta Lead"]);
    // Admin sees every active process; an agent only the ones they're mapped to.
    expect((await myProcesses(admin)).map((p) => p.name).sort()).toEqual(["Sales", "Zeta Support"]);
    expect((await myProcesses(agentA)).map((p) => p.name)).toEqual(["Sales"]);
  });
});

describe("column, system and custom-field filters (shared by Leads + console)", () => {
  it("custom fields by type, campaign/outcome/city/attempts, date ranges, new system filters", async () => {
    const { parseCustomFilters } = await import("@/lib/leads/list");
    const { getQueue } = await import("@/lib/agent/queue");
    const mkLead = (name: string, phone: string, extra: Partial<typeof s.leads.$inferInsert>, email?: string) =>
      withTenant(admin, async (tx) => {
        const [c] = await tx.insert(s.contacts).values({ name, phoneE164: phone ? `+91${phone}` : null, phoneKey: phone || null, email: email ?? null }).returning();
        const [l] = await tx.insert(s.leads).values({ processId, contactId: c!.id, stage: "New", dedupeKey: phone || crypto.randomUUID(), source: { kind: "manual" }, ...extra }).returning();
        return l!.id;
      });
    const a = await mkLead("CF Alpha", "9600000001", { custom: { budget: "12", visit: "2026-10-05", course: "MBA", site_visit: true, city: "Pune" }, source: { kind: "manual", campaign: "Diwali" }, attempts: 3, lastDisposition: { code: "BUSY", label: "Busy", category: "neutral", at: new Date().toISOString() } }, "alpha@x.in");
    const b = await mkLead("CF Beta", "9600000002", { custom: { budget: "30", visit: "2026-11-20", course: "BBA", site_visit: "no", city: "Mumbai" }, attempts: 0 });
    await mkLead("CF Gamma", "", { custom: { budget: "not a number", course: "MBA" }, createdAt: new Date("2026-01-15T06:00:00Z") });

    const names = async (q: Record<string, string>) => (await listLeads(admin, { status: "all", q: "CF", ...q })).items.map((r) => r.name).sort();
    expect(await names({})).toEqual(["CF Alpha", "CF Beta", "CF Gamma"]);
    // Custom fields
    expect(await names({ cf_budget: "n:10..20" })).toEqual(["CF Alpha"]); // "not a number" never breaks the query
    expect(await names({ cf_budget: "n:25.." })).toEqual(["CF Beta"]);
    expect(await names({ cf_visit: "d:2026-10-01..2026-10-31" })).toEqual(["CF Alpha"]);
    expect(await names({ cf_course: "=MBA" })).toEqual(["CF Alpha", "CF Gamma"]);
    expect(await names({ cf_course: "=MBA|BBA" })).toEqual(["CF Alpha", "CF Beta", "CF Gamma"]);
    expect(await names({ cf_city: "~pun" })).toEqual(["CF Alpha"]);
    expect(await names({ cf_site_visit: "b:yes" })).toEqual(["CF Alpha"]);
    expect(await names({ cf_site_visit: "b:no" })).toEqual(["CF Beta", "CF Gamma"]);
    // Columns
    expect(await names({ campaign: "Diwali" })).toEqual(["CF Alpha"]);
    expect(await names({ outcome: "Busy" })).toEqual(["CF Alpha"]);
    expect(await names({ city: "mum" })).toEqual(["CF Beta"]);
    expect(await names({ attempts_min: "1" })).toEqual(["CF Alpha"]);
    expect(await names({ attempts_max: "0" })).toEqual(["CF Beta", "CF Gamma"]);
    expect(await names({ created_from: "2026-01-01", created_to: "2026-01-31" })).toEqual(["CF Gamma"]);
    // System filters
    expect(await names({ flag: "has_email" })).toEqual(["CF Alpha"]);
    expect(await names({ flag: "no_phone" })).toEqual(["CF Gamma"]);
    expect(await names({ flag: "touched" })).toEqual(["CF Alpha"]);
    expect(await names({ flag: "stale_7d" })).toEqual(["CF Gamma"]);
    expect(await names({ flag: "has_email,touched" })).toEqual(["CF Alpha"]); // AND
    // Same filter in the console queue (open leads, same SQL)
    expect((await getQueue(admin, 150, { q: "CF", cf_budget: "n:10..20" })).map((l) => l.id)).toEqual([a]);
    expect((await getQueue(admin, 150, { q: "CF", cf_course: "=BBA" })).map((l) => l.id)).toEqual([b]);
    // Garbage cf params are ignored, never injected
    expect(parseCustomFilters({ "cf_x; drop table leads": "~a", cf_ok: "n:abc..", cf_d: "d:yesterday.." })).toEqual([{ key: "ok", op: "num", min: undefined, max: undefined }, { key: "d", op: "date", from: undefined, to: undefined }]);
  });
});
