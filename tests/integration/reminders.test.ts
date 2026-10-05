/**
 * Reminders at scale (code review 2026-10-05): an unassigned-lead SLA alert
 * is sent once per lead (leads.sla_alerted_at) instead of re-scanning the same
 * oldest leads every 5 minutes; the run stops at its deadline.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { TenantContext } from "@/lib/tenancy/context";

vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));
const { runCallbackReminders } = await import("@/lib/platform-admin/reminders");

let db: TestDb;
let close: () => Promise<void>;
let T: TenantContext;
let leadId: string;
let supId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  T = await seedTenant(db, "rem-t");
  ({ leadId, supId } = await withTenant(T, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "Sales", stages: ["New"], assignment: { method: "equal", sticky: false, slaMinutes: 1 } }).returning();
    const [sup] = await tx.insert(s.users).values({ email: "sup@rem.test", name: "Sup", role: "project_supervisor" }).returning();
    await tx.insert(s.userProcesses).values({ userId: sup!.id, processId: p!.id });
    const [c] = await tx.insert(s.contacts).values({ name: "Late" }).returning();
    const [l] = await tx.insert(s.leads).values({ processId: p!.id, contactId: c!.id, source: { kind: "manual" }, stage: "New", dedupeKey: `nokey:${crypto.randomUUID()}`, createdAt: new Date(Date.now() - 10 * 60_000) }).returning();
    return { leadId: l!.id, supId: sup!.id };
  }));
}, 60_000);
afterAll(async () => close());

const alerts = () => withTenant(T, (tx) => tx.select().from(s.notifications).where(eq(s.notifications.userId, supId)));

describe("SLA alerts", () => {
  it("alerts supervisors once, marks the lead, and skips it on later runs", async () => {
    expect((await runCallbackReminders()).slaAlerts).toBe(1);
    expect((await alerts()).length).toBe(1);
    const [l] = await withTenant(T, (tx) => tx.select({ at: s.leads.slaAlertedAt }).from(s.leads).where(eq(s.leads.id, leadId)));
    expect(l!.at).not.toBeNull();
    expect((await runCallbackReminders()).slaAlerts).toBe(0);
    expect((await alerts()).length).toBe(1);
  });

  it("does nothing once its deadline has passed", async () => {
    expect(await runCallbackReminders(new Date(), Date.now() - 1)).toMatchObject({ reminded: 0, missed: 0, slaAlerts: 0, errors: 0 });
  });
});
