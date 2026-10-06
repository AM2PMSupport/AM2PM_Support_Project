/**
 * Lead layout on real Postgres (PGlite, real RLS): save / reset (config E
 * only, normalised, per workspace), the layout reaching the Console lead,
 * the lead page and Manage Columns, new field types end to end, and Create
 * Lead enforcing required custom fields (API stays lenient).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const { saveLayout, resetLayout, getLayoutEditor } = await import("@/lib/admin/layout");
const { createField } = await import("@/lib/admin/custom-fields");
const { getLeadDetail } = await import("@/lib/agent/queue");
const { getLeadForEdit, updateLead } = await import("@/lib/leads/edit");
const { leadFilterOptions } = await import("@/lib/leads/list");
const { createManualLead } = await import("@/lib/leads/manual");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let agent: SessionContext;
let other: SessionContext;
let processId: string;
let leadId: string;

async function mk(t: Awaited<ReturnType<typeof seedTenant>>, email: string, role: Role): Promise<SessionContext> {
  const base = { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug };
  const [u] = await withTenant({ ...base, actor: { userId: "", role, name: email } }, (tx) => tx.insert(s.users).values({ email, name: email, role, maxOpenLeads: 100 }).returning());
  return { ...base, actor: { userId: u!.id, role, name: email } };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "layout-t");
  admin = await mk(t, "admin@l.test", "admin");
  agent = await mk(t, "agent@l.test", "agent");
  other = await mk(await seedTenant(db, "layout-o"), "admin@o.test", "admin");
  await withTenant(admin, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "Sales", stages: ["New", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    processId = p!.id;
  });
  await createField(admin, { entity: "lead", processId: null, label: "Budget", type: "currency", options: [], required: false });
  await createField(admin, { entity: "lead", processId, label: "Plan", type: "radio", options: ["Basic", "Pro"], required: true });
  const r = await createManualLead(admin, { processId, name: "Asha", phone: "9876543210", custom: { budget: "50000", plan: "Pro" } });
  leadId = r.leadId;
}, 60_000);
afterAll(async () => close());

describe("lead layout", () => {
  it("default layout lists every field once; new custom fields land in a section", async () => {
    const ed = await getLayoutEditor(admin);
    expect(ed.customised).toBe(false);
    const placed = ed.layout.sections.flatMap((x) => x.fields);
    expect(placed).toContain("cf:budget");
    expect(placed).toContain("cf:plan");
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("saving: config E only, normalised, applied to the Console lead and the lead page, per workspace", async () => {
    await expect(saveLayout(agent, {})).rejects.toMatchObject({ status: 403 });
    const saved = await saveLayout(admin, {
      sections: [
        { id: "money", title: "Money first", fields: ["cf:budget", "cf:plan", "sys:name", "sys:phone", "sys:bogus"] },
        { id: "rest", title: "The rest", fields: ["sys:stage"] },
      ],
      hidden: ["sys:email", "sys:name"],
      labels: { "sys:phone": "Customer phone" },
    });
    expect(saved.hidden).toEqual(["sys:email"]); // Name can't be hidden; unknown ref dropped
    const lead = await getLeadDetail(admin, leadId);
    expect(lead.layout[0]!.title).toBe("Money first");
    // Fields the saved layout didn't mention are appended after these (never lost).
    expect(lead.layout[0]!.fields.slice(0, 4).map((f) => f.label)).toEqual(["Budget", "Plan", "Name", "Customer phone"]);
    expect(lead.layout.flatMap((x) => x.fields).some((f) => f.ref === "sys:email")).toBe(false);
    expect((await getLeadForEdit(admin, leadId)).layout[0]!.fields[0]!.ref).toBe("cf:budget");
    // Another workspace still has its own default.
    expect((await getLayoutEditor(other)).customised).toBe(false);
  });

  it("Manage Columns offers custom fields in layout order with layout labels; rows carry the values", async () => {
    const opts = await leadFilterOptions(admin);
    expect(opts.columns.slice(0, 3)).toEqual([{ key: "cf:budget", label: "Budget" }, { key: "cf:plan", label: "Plan" }, { key: "phone", label: "Customer phone" }]);
    expect(opts.columns.some((c) => c.key === "email")).toBe(false); // hidden in the layout
  });

  it("new types validate on edit; required custom fields block a manual create but not the API", async () => {
    await updateLead(admin, { leadId, custom: { budget: "₹75,000" } });
    expect((await getLeadDetail(admin, leadId)).custom.budget).toBe(75000);
    await expect(updateLead(admin, { leadId, custom: { plan: "Enterprise" } })).rejects.toThrow(/must be one of/);
    await expect(createManualLead(admin, { processId, name: "Ravi", phone: "9876500001" })).rejects.toThrow(/Plan is required/);
    await expect(createManualLead(admin, { processId, name: "Ravi", phone: "9876500001" }, "api")).resolves.toMatchObject({ outcome: "created" });
  });

  it("reset puts the default back", async () => {
    await resetLayout(admin);
    const ed = await getLayoutEditor(admin);
    expect(ed.customised).toBe(false);
    expect(ed.layout.sections[0]!.title).toBe("Lead information");
  });
});
