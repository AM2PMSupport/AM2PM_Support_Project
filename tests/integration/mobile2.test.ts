/**
 * Mobile 2 (contacts.alt_phone_*) on real Postgres (RLS): create, edit,
 * list + search on either number, inbound call from Mobile 2 merging into
 * the contact's lead, click-to-call dialling the chosen number, and another
 * tenant unable to dial it.
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
// Provider HTTP replaced: record which number the CRM asked it to ring.
const dialled: string[] = [];
vi.mock("@/lib/telephony/registry", () => ({
  telephonyAdapter: () => ({
    name: "callerdesk",
    clickToCall: async (req: { customerNumber: string }) => {
      dialled.push(req.customerNumber);
      return { ok: true, providerCallId: `camp-${dialled.length}` };
    },
  }),
}));
vi.mock("@/lib/crypto", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/crypto")>()), decrypt: () => "{}" }));

const { createManualLead } = await import("@/lib/leads/manual");
const { listLeads } = await import("@/lib/leads/list");
const { updateLead } = await import("@/lib/leads/edit");
const { getLeadDetail } = await import("@/lib/agent/queue");
const { placeCall } = await import("@/lib/telephony/click-to-call");
const { releaseCallLock } = await import("@/lib/telephony/lock");
const { applyCallEvents } = await import("@/lib/telephony/call-events");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let other: SessionContext;
let processId: string;
let integration: s.Integration;

async function mk(t: Awaited<ReturnType<typeof seedTenant>>, email: string, role: Role, phone10: string): Promise<SessionContext> {
  const base = { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug };
  const [u] = await withTenant({ ...base, actor: { userId: "", role, name: email } }, (tx) =>
    tx.insert(s.users).values({ email, name: email, role, maxOpenLeads: 100, agentPhone10: phone10, agentPhoneE164: `+91${phone10}` }).returning(),
  );
  return { ...base, actor: { userId: u!.id, role, name: email } };
}

async function seedProcessAndTelephony(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "Sales", stages: ["New", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    const [i] = await tx.insert(s.integrations).values({ kind: "telephony", provider: "callerdesk", credentialsEnc: "x" }).returning();
    await tx.insert(s.telephonyDids).values({ integrationId: i!.id, number: "07971544878", number10: "7971544878", processId: p!.id, direction: "both" });
    return { processId: p!.id, integration: i! };
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "m2-t");
  admin = await mk(t, "admin@m2.test", "admin", "9000000011");
  other = await mk(await seedTenant(db, "m2-other"), "admin@m2o.test", "admin", "9000000012");
  ({ processId, integration } = await seedProcessAndTelephony(admin));
  await seedProcessAndTelephony(other);
}, 60_000);
afterAll(async () => close());

let leadId: string;

describe("Mobile 2", () => {
  it("is saved on create, shown in the list and the console, and found by search", async () => {
    ({ leadId } = await createManualLead(admin, { processId, name: "Two Numbers", phone: "98765 43210", altPhone: "+91 91234 56789" }));
    const page = await listLeads(admin, { q: "Two Numbers" });
    expect(page.items[0]).toMatchObject({ id: leadId, phone: "+91 98765 43210", altPhone: "+91 91234 56789" });
    expect((await listLeads(admin, { q: "9123456789" })).items.map((r) => r.id)).toEqual([leadId]); // exact, Mobile 2
    expect((await listLeads(admin, { q: "56789" })).items.map((r) => r.id)).toContain(leadId); // partial, Mobile 2
    expect((await getLeadDetail(admin, leadId)).altPhone).toBe("+91 91234 56789");
  });

  it("rejects a bad or duplicate Mobile 2 typed by a person", async () => {
    await expect(createManualLead(admin, { processId, name: "Bad", phone: "9876500000", altPhone: "12345" })).rejects.toThrow(/Mobile 2/);
    await expect(createManualLead(admin, { processId, name: "Same", phone: "9876500001", altPhone: "9876500001" })).rejects.toThrow(/Mobile 2/);
  });

  it("can be changed, refused when equal to the main number, and removed", async () => {
    await updateLead(admin, { leadId, altPhone: "9000011111" });
    expect((await getLeadDetail(admin, leadId)).altPhone).toBe("+91 90000 11111");
    await expect(updateLead(admin, { leadId, altPhone: "9876543210" })).rejects.toThrow(/same as the main number/);
    await expect(updateLead(admin, { leadId, altPhone: "123" })).rejects.toThrow(/Mobile 2/);
    // Two numbers pasted into one box: "last 10" looks valid but it isn't one number.
    await expect(updateLead(admin, { leadId, altPhone: "5510099996000000001" })).rejects.toThrow(/Mobile 2/);
    await expect(updateLead(admin, { leadId, phone: "5510099996000000001" })).rejects.toThrow(/valid 10-digit/);
    // A half-stored Mobile 2 (key, no E.164) is still validated on the next save.
    await withTenant(admin, async (tx) => {
      const [l] = await tx.select({ c: s.leads.contactId }).from(s.leads).where(eq(s.leads.id, leadId));
      await tx.update(s.contacts).set({ altPhoneKey: "6000000001", altPhoneE164: null }).where(eq(s.contacts.id, l!.c));
    });
    await expect(updateLead(admin, { leadId, altPhone: "5510099996000000001" })).rejects.toThrow(/Mobile 2/);
    await updateLead(admin, { leadId, altPhone: "" });
    expect((await getLeadDetail(admin, leadId)).altPhone).toBeNull();
    await updateLead(admin, { leadId, altPhone: "9123456789" });
  });

  it("click-to-call dials the number asked for and records it on the call", async () => {
    dialled.length = 0;
    const a = await placeCall(admin, leadId, "alt");
    await releaseCallLock(admin.tenantId, admin.actor.userId, (await callRow(a.interactionId)).correlationId!);
    const b = await placeCall(admin, leadId);
    await releaseCallLock(admin.tenantId, admin.actor.userId, (await callRow(b.interactionId)).correlationId!);
    expect(dialled).toEqual(["+919123456789", "+919876543210"]);
    expect((await callRow(a.interactionId)).customerNumber).toBe("+919123456789");
  });

  it("says so when there is no Mobile 2 to dial", async () => {
    const { leadId: single } = await createManualLead(admin, { processId, name: "One Number", phone: "9811100000" });
    await expect(placeCall(admin, single, "alt")).rejects.toThrow(/no second number/);
  });

  it("inbound call from Mobile 2 lands on the contact's existing lead", async () => {
    const before = await withTenant(admin, (tx) => tx.select({ id: s.leads.id }).from(s.leads));
    await applyCallEvents(admin, integration, [{ kind: "missed", direction: "inbound", providerCallId: "in-m2", did: "07971544878", customerNumber: "09123456789", at: new Date() }]);
    const after = await withTenant(admin, (tx) => tx.select({ id: s.leads.id }).from(s.leads));
    expect(after.length).toBe(before.length); // merged, not a new lead
    const [call] = await withTenant(admin, (tx) => tx.select().from(s.interactions).where(eq(s.interactions.providerCallId, "in-m2")));
    expect(call).toMatchObject({ leadId, customerNumber: "+919123456789" });
  });

  it("another workspace cannot dial or see it", async () => {
    await expect(placeCall(other, leadId, "alt")).rejects.toThrow(/not found/i);
    expect((await listLeads(other, { q: "9123456789" })).items).toEqual([]);
  });
});

async function callRow(id: string) {
  const [r] = await withTenant(admin, (tx) => tx.select().from(s.interactions).where(eq(s.interactions.id, id)));
  return r!;
}

describe("editing a lead keyed nokey: at intake", () => {
  it("doesn't re-key it on an unrelated edit (twin lead with the same number stays fine)", async () => {
    const ids = await withTenant(admin, async (tx) => {
      const [c] = await tx.insert(s.contacts).values({ name: "Twin", phoneE164: "+915510000000", phoneKey: "5510000000" }).returning();
      const mkLead = (dedupeKey: string) => tx.insert(s.leads).values({ processId, contactId: c!.id, source: { kind: "csv" }, stage: "New", dedupeKey }).returning();
      const [a] = await mkLead("5510000000");
      const [b] = await mkLead(`nokey:${crypto.randomUUID()}`);
      return [a!.id, b!.id];
    });
    await updateLead(admin, { leadId: ids[1]!, name: "Twin B", phone: "+91 55100 00000", altPhone: "9123400000" });
    expect((await getLeadDetail(admin, ids[1]!)).altPhone).toBe("+91 91234 00000");
  });
});
