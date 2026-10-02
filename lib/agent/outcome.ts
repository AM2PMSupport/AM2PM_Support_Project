/**
 * Save a call outcome / change a stage (T1.35, T1.41, PRD FR-20).
 *
 * One transaction, with the lead row locked, does everything the outcome's
 * CATEGORY implies (DESIGN.md §2.3):
 *   callback  → pending callback at the chosen time, next_callback_at set
 *   converted → status won, stage = won stage, converted_at, open_leads − 1, outbox lead.converted
 *   negative  → status lost, open_leads − 1, outbox lead.lost
 *   dnc       → contact.dnc, status dnc, open_leads − 1, outbox lead.lost
 *   positive / neutral → stays open
 * Always: outcome on the latest call (or a note interaction if there was no
 * call), lead.last_disposition, lead_events, outbox disposition.set, and any
 * other pending callbacks for this lead are marked done.
 * Outbox events are published after commit (never inside the transaction).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { callbacks, contacts, dispositions, interactions, leadEvents, leads, processes, users } from "@/lib/db/schema";
import { withTenant, type Tx } from "@/lib/db/tenant";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { leadScopeCondition } from "@/lib/leads/scope";
import { publishOutboxAfterResponse, writeOutbox } from "@/lib/events/outbox";
import { badRequest, conflict, notFound } from "@/lib/http/errors";

export const OutcomeInput = z.object({
  leadId: z.uuid(),
  dispositionId: z.uuid(),
  note: z.string().trim().max(1000).optional().default(""),
  /** ISO time; required for callback outcomes. */
  callbackAt: z.iso.datetime({ offset: true }).optional(),
});

async function lockLead(tx: Tx, ctx: SessionContext, leadId: string) {
  const [lead] = await tx
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), leadScopeCondition(ctx)))
    .for("update");
  if (!lead) throw notFound("Lead not found");
  return lead;
}

/** Close the lead: release the owner's capacity slot. */
async function closeLead(tx: Tx, lead: typeof leads.$inferSelect) {
  if (lead.assignedTo && lead.status === "open") {
    await tx.update(users).set({ openLeads: sql`greatest(${users.openLeads} - 1, 0)` }).where(eq(users.id, lead.assignedTo));
  }
  await tx.update(callbacks).set({ status: "cancelled" }).where(and(eq(callbacks.leadId, lead.id), eq(callbacks.status, "pending")));
}

export async function saveOutcome(ctx: SessionContext, input: z.infer<typeof OutcomeInput>) {
  requirePermission(ctx, "leads", "E");
  const now = new Date();
  const outboxIds = await withTenant(ctx, async (tx) => {
    const lead = await lockLead(tx, ctx, input.leadId);
    if (lead.status !== "open") throw conflict("This lead is already closed", "lead_closed");
    const [d] = await tx.select().from(dispositions).where(and(eq(dispositions.id, input.dispositionId), eq(dispositions.isActive, true)));
    if (!d || (d.processId && d.processId !== lead.processId)) throw badRequest("Pick an outcome for this process");
    if (d.category === "callback") {
      if (!input.callbackAt) throw badRequest("Pick a callback time");
      if (new Date(input.callbackAt).getTime() < now.getTime() - 60_000) throw badRequest("The callback time is in the past");
    }
    const snapshot = { code: d.code, label: d.label, category: d.category, at: now.toISOString() };
    const ids: string[] = [];

    // Outcome on this agent's latest call for the lead (within 2 h), else a note.
    const [call] = await tx
      .select({ id: interactions.id })
      .from(interactions)
      .where(and(eq(interactions.leadId, lead.id), eq(interactions.type, "call"), eq(interactions.agentId, ctx.actor.userId), sql`${interactions.startedAt} > now() - interval '2 hours'`, sql`${interactions.disposition} is null`))
      .orderBy(desc(interactions.startedAt))
      .limit(1);
    if (call) {
      await tx.update(interactions).set({ disposition: { code: d.code, label: d.label, category: d.category }, notes: input.note || null }).where(eq(interactions.id, call.id));
    } else {
      await tx.insert(interactions).values({
        type: "note", direction: "outbound", leadId: lead.id, contactId: lead.contactId, processId: lead.processId,
        agentId: ctx.actor.userId, agentName: ctx.actor.name, status: "completed", disposition: { code: d.code, label: d.label, category: d.category }, notes: input.note || null,
      });
    }

    // Done with any earlier pending callbacks (a new one may follow below).
    await tx.update(callbacks).set({ status: "done" }).where(and(eq(callbacks.leadId, lead.id), eq(callbacks.status, "pending")));

    const patch: Partial<typeof leads.$inferInsert> = { lastDisposition: snapshot, lastInteractionAt: now, nextCallbackAt: null };
    if (d.category === "callback") {
      const due = new Date(input.callbackAt!);
      await tx.insert(callbacks).values({ leadId: lead.id, assignedTo: lead.assignedTo ?? ctx.actor.userId, dueAt: due, reason: "agent" });
      patch.nextCallbackAt = due;
      await tx.insert(leadEvents).values({ leadId: lead.id, type: "callback_set", actor: { kind: "user", id: ctx.actor.userId, name: ctx.actor.name }, after: { dueAt: due.toISOString() } });
    } else if (d.category === "converted") {
      const [p] = await tx.select({ wonStage: processes.wonStage }).from(processes).where(eq(processes.id, lead.processId));
      await closeLead(tx, lead);
      Object.assign(patch, { status: "won", stage: p!.wonStage, convertedAt: now });
      await tx.insert(leadEvents).values({ leadId: lead.id, type: "converted", actor: { kind: "user", id: ctx.actor.userId, name: ctx.actor.name }, after: { outcome: d.label } });
      ids.push(await writeOutbox(tx, "lead.converted", lead.id, { leadId: lead.id, processId: lead.processId, stage: p!.wonStage, outcome: d.label, agentId: ctx.actor.userId }));
    } else if (d.category === "negative" || d.category === "dnc") {
      await closeLead(tx, lead);
      Object.assign(patch, { status: d.category === "dnc" ? "dnc" : "lost" });
      if (d.category === "dnc") await tx.update(contacts).set({ dnc: true }).where(eq(contacts.id, lead.contactId));
      await tx.insert(leadEvents).values({ leadId: lead.id, type: "lost", actor: { kind: "user", id: ctx.actor.userId, name: ctx.actor.name }, after: { outcome: d.label } });
      ids.push(await writeOutbox(tx, "lead.lost", lead.id, { leadId: lead.id, processId: lead.processId, outcome: d.label, dnc: d.category === "dnc" }));
    }
    await tx.update(leads).set(patch).where(eq(leads.id, lead.id));
    await tx.insert(leadEvents).values({
      leadId: lead.id,
      type: "disposition_set",
      actor: { kind: "user", id: ctx.actor.userId, name: ctx.actor.name },
      after: { label: d.label, category: d.category, ...(input.note ? { note: input.note } : {}) },
    });
    ids.push(await writeOutbox(tx, "disposition.set", lead.id, { leadId: lead.id, processId: lead.processId, outcome: d.label, category: d.category, agentId: ctx.actor.userId }));
    return ids;
  });
  await publishOutboxAfterResponse(ctx, outboxIds);
  return { ok: true };
}

export const StageInput = z.object({ leadId: z.uuid(), stage: z.string().trim().min(1).max(30) });

/** Move a lead's stage; reaching the won stage converts it. */
export async function setStage(ctx: SessionContext, input: z.infer<typeof StageInput>) {
  requirePermission(ctx, "leads", "E");
  const outboxIds = await withTenant(ctx, async (tx) => {
    const lead = await lockLead(tx, ctx, input.leadId);
    if (lead.status !== "open") throw conflict("This lead is already closed", "lead_closed");
    const [p] = await tx.select({ stages: processes.stages, wonStage: processes.wonStage }).from(processes).where(eq(processes.id, lead.processId));
    if (!p!.stages.includes(input.stage)) throw badRequest("Unknown stage for this process");
    if (input.stage === lead.stage) return [];
    const ids: string[] = [];
    if (input.stage === p!.wonStage) {
      await closeLead(tx, lead);
      await tx.update(leads).set({ stage: input.stage, status: "won", convertedAt: new Date() }).where(eq(leads.id, lead.id));
      await tx.insert(leadEvents).values({ leadId: lead.id, type: "converted", actor: { kind: "user", id: ctx.actor.userId, name: ctx.actor.name }, after: { stage: input.stage } });
      ids.push(await writeOutbox(tx, "lead.converted", lead.id, { leadId: lead.id, processId: lead.processId, stage: input.stage, agentId: ctx.actor.userId }));
    } else {
      await tx.update(leads).set({ stage: input.stage }).where(eq(leads.id, lead.id));
    }
    await tx.insert(leadEvents).values({ leadId: lead.id, type: "stage_changed", actor: { kind: "user", id: ctx.actor.userId, name: ctx.actor.name }, before: { stage: lead.stage }, after: { stage: input.stage } });
    ids.push(await writeOutbox(tx, "lead.stage_changed", lead.id, { leadId: lead.id, processId: lead.processId, stage: input.stage }));
    return ids;
  });
  await publishOutboxAfterResponse(ctx, outboxIds);
  return { ok: true };
}

/** The signed-in agent's live call, if any (drives the console stepper + inbound screen-pop). */
export async function getMyLiveCall(ctx: SessionContext, interactionId?: string) {
  return withTenant(ctx, async (tx) => {
    const where = interactionId
      ? and(eq(interactions.id, interactionId), eq(interactions.agentId, ctx.actor.userId))
      : and(eq(interactions.agentId, ctx.actor.userId), eq(interactions.type, "call"), sql`${interactions.status} in ('initiated','agent_ringing','customer_ringing','answered','ringing')`, sql`${interactions.startedAt} > now() - interval '2 hours'`);
    const [c] = await tx
      .select({ id: interactions.id, leadId: interactions.leadId, direction: interactions.direction, status: interactions.status, startedAt: interactions.startedAt, durationSec: interactions.durationSec, endReason: interactions.endReason, updatedAt: interactions.updatedAt })
      .from(interactions)
      .where(where)
      .orderBy(desc(interactions.startedAt))
      .limit(1);
    return c ? { ...c, startedAt: c.startedAt.toISOString(), updatedAt: c.updatedAt.toISOString() } : null;
  });
}

/**
 * "End that call": the agent clears their own call that the provider never
 * reported back on (no webhook — e.g. a test number), instead of waiting up
 * to 15 min for the lock to expire. Same result as the stuck-call sweeper:
 * status "unknown" (a late real webhook may still correct it), lock freed.
 * Only the agent's OWN unfinished calls are touched.
 */
export async function endMyStuckCall(ctx: SessionContext): Promise<{ ended: number }> {
  const { activeCallId, releaseCallLock } = await import("@/lib/telephony/lock");
  const holder = await activeCallId(ctx.tenantId, ctx.actor.userId);
  const ended = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .update(interactions)
      .set({ status: "unknown", endedAt: new Date(), endReason: "ended_by_agent" })
      .where(
        and(
          eq(interactions.agentId, ctx.actor.userId),
          eq(interactions.type, "call"),
          sql`${interactions.status} in ('initiated','agent_ringing','customer_ringing','ringing')`,
          holder ? sql`(${interactions.correlationId} = ${holder} or ${interactions.startedAt} < now() - interval '2 minutes')` : sql`true`,
        ),
      )
      .returning({ id: interactions.id });
    return rows.length;
  });
  if (holder) await releaseCallLock(ctx.tenantId, ctx.actor.userId, holder);
  return { ended };
}
