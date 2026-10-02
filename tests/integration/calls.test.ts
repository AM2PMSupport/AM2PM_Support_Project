/**
 * Calls log, recordings and the CallerDesk sync on real Postgres (RLS).
 *   - a Call Report API row (documented shape) fixes a call stuck as
 *     "unknown": completed + durations + recording + copy queued (once)
 *   - agents see only their own calls; other workspaces see none
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, fakeRedis, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";

import { randomBytes } from "node:crypto";
process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.CRON_SECRET ??= "test-cron-secret-0123456789";

const enqueue = vi.fn(async () => "msg");
vi.mock("@/lib/queue/qstash", () => ({ enqueue, verifyQStash: vi.fn() }));
const r = fakeRedis();
vi.mock("@/lib/redis/client", async (orig) => ({ ...(await orig<typeof import("@/lib/redis/client")>()), redis: () => r }));
const { encrypt } = await import("@/lib/crypto");
const { syncCalls } = await import("@/lib/telephony/sync");
const { listCalls } = await import("@/lib/calls/list");
const { callListRowToReport, callerDeskAdapter } = await import("@/lib/providers/telephony/callerdesk/adapter");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let agent: SessionContext;
let other: SessionContext;
let processId: string;
let leadId: string;
let callId: string;

async function mk(t: Awaited<ReturnType<typeof seedTenant>>, email: string, role: Role, extra: Partial<typeof s.users.$inferInsert> = {}): Promise<SessionContext> {
  const base = { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug };
  const [u] = await withTenant({ ...base, actor: { userId: "", role, name: email } }, (tx) => tx.insert(s.users).values({ email, name: email, role, ...extra }).returning());
  return { ...base, actor: { userId: u!.id, role, name: email } };
}

// CallerDesk Call Report API row (docs sample shape, numbers changed): outgoing click-to-call.
const ROW = {
  id: "11554512", sid_id: "1641549947.1751", file: "https://newcallrecords.callerdesk.io/outgoing/x.wav", deskphone: "07971544878",
  caller_num: "09811113333", member_num: "09000000002", member_name: "Agent", startdatetime: "2026-10-02 12:00:05", enddatetime: "2026-10-02 12:01:45",
  total_duration: "100", talk_duration: "80", callresult: "Answered", callstatus: "ANSWER",
  LegA_Picked_time: "2026-10-02 12:00:09", LegB_Start_time: "2026-10-02 12:00:10", LegB_Picked_time: "2026-10-02 12:00:25", Flow_type: "WEBOBD",
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "calls-t");
  admin = await mk(t, "admin@c.test", "admin");
  agent = await mk(t, "agent@c.test", "agent", { agentPhone10: "9000000002", agentPhoneE164: "+919000000002" });
  other = await mk(await seedTenant(db, "calls-other"), "x@o.test", "admin");
  await withTenant(admin, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "P", stages: ["New", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    processId = p!.id;
    const [i] = await tx.insert(s.integrations).values({ kind: "telephony", provider: "callerdesk", credentialsEnc: encrypt(JSON.stringify({ authCode: "AUTH" })) }).returning();
    await tx.insert(s.telephonyDids).values({ integrationId: i!.id, number: "07971544878", number10: "7971544878", processId, direction: "both" });
    const [c] = await tx.insert(s.contacts).values({ name: "Asha", phoneE164: "+919811113333", phoneKey: "9811113333" }).returning();
    const [l] = await tx.insert(s.leads).values({ processId, contactId: c!.id, source: { kind: "manual" }, stage: "New", dedupeKey: "9811113333", assignedTo: agent.actor.userId }).returning();
    leadId = l!.id;
    // Our call: CallerDesk accepted it, but no webhook ever came → swept to "unknown".
    const [call] = await tx
      .insert(s.interactions)
      .values({ type: "call", direction: "outbound", leadId, processId, agentId: agent.actor.userId, agentName: "Agent", status: "unknown", endReason: "no_webhook", provider: "callerdesk", providerCallId: "55890782", correlationId: crypto.randomUUID(), agentNumber: "9000000002", customerNumber: "+919811113333", startedAt: new Date("2026-10-02T06:30:03Z") })
      .returning();
    callId = call!.id;
  });
}, 60_000);
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

describe("Call Report API row → same parser as webhooks", () => {
  it("outgoing row: agent = member_num, customer = caller_num, completed, recording", () => {
    const [ev, rec] = callerDeskAdapter.parseWebhook(callListRowToReport(ROW), { registeredDids: ["07971544878"] });
    expect(ev).toMatchObject({ kind: "completed", direction: "outbound", agentNumber: "9000000002", customerNumber: "9811113333", durationSec: 100, talkSec: 80 });
    expect(rec!.kind).toBe("recording_ready");
  });
  it("'0000-00-00' leg times mean the agent never picked up", () => {
    const [ev] = callerDeskAdapter.parseWebhook(callListRowToReport({ ...ROW, callstatus: "cancel-Agent", callresult: "", LegA_Picked_time: "0000-00-00 00:00:00", LegB_Start_time: "0000-00-00 00:00:00", LegB_Picked_time: "0000-00-00 00:00:00", file: "" }), { registeredDids: [] });
    expect(ev!.kind).toBe("agent_no_answer");
  });
});

describe("syncCalls", () => {
  it("fixes the stuck call from CallerDesk's report, stores the recording link, queues the copy once", async () => {
    const posted: FormData[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      posted.push(init.body as FormData);
      return new Response(JSON.stringify({ type: "success", result: [ROW], current_page: 1, total: 1 }));
    });
    const res = await syncCalls(admin, ["2026-10-02"]);
    expect(res).toMatchObject({ rows: 1, failed: 0 });
    expect(posted[0]!.get("authcode")).toBe("AUTH");
    expect(posted[0]!.get("start_date")).toBe("2026-10-02");
    const [call] = await db.select().from(s.interactions).where(eq(s.interactions.id, callId));
    expect(call).toMatchObject({ status: "completed", durationSec: 100, recordingUrl: ROW.file });
    const copies = () => enqueue.mock.calls.filter((c) => (c as unknown[])[0] === "copy-recording").length;
    expect(copies()).toBe(1);
    // Copy not finished yet → the next run re-queues it (same dedupe id; QStash drops repeats).
    await syncCalls(admin, ["2026-10-02"]);
    expect(copies()).toBe(2);
    expect((enqueue.mock.calls.at(-1) as unknown[])[2]).toEqual({ deduplicationId: `rec:${callId}` });
    // Once copied, later runs queue nothing.
    await db.update(s.interactions).set({ recordingKey: "recordings/x.wav" }).where(eq(s.interactions.id, callId));
    await syncCalls(admin, ["2026-10-02"]);
    expect(copies()).toBe(2);
  });
});

describe("listCalls", () => {
  it("shows the call with durations and recording; agents see only their own; other workspace sees none", async () => {
    const all = await listCalls(admin, { range: "all" });
    expect(all.items[0]).toMatchObject({ id: callId, status: "completed", durationSec: 100, talkSec: 80, hasRecording: true, leadName: "Asha" });
    expect((await listCalls(agent, { range: "all" })).total).toBe(1);
    const otherAgent = await mk({ tenantId: admin.tenantId, tenantSlug: admin.tenantSlug, timezone: admin.timezone }, "agent2@c.test", "agent");
    expect((await listCalls(otherAgent, { range: "all" })).total).toBe(0);
    expect((await listCalls(other, { range: "all" })).total).toBe(0);
    expect((await listCalls(admin, { range: "all", result: "missed" })).total).toBe(0);
    expect((await listCalls(admin, { range: "all", q: "13333" })).total).toBe(1);
  });
});
