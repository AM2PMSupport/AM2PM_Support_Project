/**
 * Bulk actions on selected leads (Leads screen): reassign owner, move stage.
 *
 * Reassign is one transaction for the whole selection: rows are locked
 * (FOR UPDATE, RULE.md §2.5), the old owner's open_leads goes down and the
 * new owner's goes up by exactly the number moved, pending callbacks follow
 * the lead, and each lead gets a lead_events row + lead.assigned outbox
 * event. The new owner must be an active agent/coordinator mapped to the
 * lead's process; other leads are skipped and reported. A manual reassign
 * may exceed the owner's soft cap (supervisor's call); auto-assign never does.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { callbacks, leadEvents, leads, userProcesses, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { canReassign, requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { leadScopeCondition } from "@/lib/leads/scope";
import { writeOutbox, publishOutboxAfterResponse } from "@/lib/events/outbox";
import { notify } from "@/lib/notifications";
import { setStage } from "@/lib/agent/outcome";
import { badRequest, forbidden } from "@/lib/http/errors";
import { writeAudit } from "@/lib/audit";

export const BulkAssignInput = z.object({ leadIds: z.array(z.uuid()).min(1).max(200), ownerId: z.uuid() });
export const BulkStageInput = z.object({ leadIds: z.array(z.uuid()).min(1).max(200), stage: z.string().trim().min(1).max(30) });

export async function bulkAssign(ctx: SessionContext, input: z.infer<typeof BulkAssignInput>) {
  if (!canReassign(ctx.actor.role)) throw forbidden("You don't have permission to reassign leads");
  const now = new Date();
  const res = await withTenant(ctx, async (tx) => {
    const [owner] = await tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.id, input.ownerId), eq(users.status, "active"), inArray(users.role, ["agent", "process_coordinator"])));
    if (!owner) throw badRequest("Pick an active agent");
    const mapped = new Set((await tx.select({ p: userProcesses.processId }).from(userProcesses).where(eq(userProcesses.userId, owner.id))).map((r) => r.p));
    const rows = await tx
      .select({ id: leads.id, processId: leads.processId, assignedTo: leads.assignedTo, status: leads.status })
      .from(leads)
      .where(and(inArray(leads.id, input.leadIds), leadScopeCondition(ctx)))
      .for("update");
    const moving = rows.filter((l) => l.assignedTo !== owner.id && mapped.has(l.processId));
    const skipped = input.leadIds.length - moving.length;
    if (!moving.length) return { moved: 0, skipped, outboxIds: [] as string[] };

    // Capacity bookkeeping: only open leads count towards open_leads.
    const openFrom = new Map<string, number>();
    for (const l of moving) if (l.status === "open" && l.assignedTo) openFrom.set(l.assignedTo, (openFrom.get(l.assignedTo) ?? 0) + 1);
    for (const [uid, n] of openFrom) await tx.update(users).set({ openLeads: sql`greatest(${users.openLeads} - ${n}, 0)` }).where(eq(users.id, uid));
    const openTo = moving.filter((l) => l.status === "open").length;
    if (openTo) await tx.update(users).set({ openLeads: sql`${users.openLeads} + ${openTo}` }).where(eq(users.id, owner.id));

    const ids = moving.map((l) => l.id);
    await tx.update(leads).set({ assignedTo: owner.id, assignedAt: now }).where(inArray(leads.id, ids));
    await tx.update(callbacks).set({ assignedTo: owner.id }).where(and(inArray(callbacks.leadId, ids), eq(callbacks.status, "pending")));
    await tx.insert(leadEvents).values(
      moving.map((l) => ({ leadId: l.id, type: (l.assignedTo ? "reassigned" : "assigned") as "reassigned" | "assigned", actor: { kind: "user" as const, id: ctx.actor.userId, name: ctx.actor.name }, before: { assignedTo: l.assignedTo }, after: { assignedTo: owner.id } })),
    );
    const outboxIds: string[] = [];
    for (const l of moving) outboxIds.push(await writeOutbox(tx, "lead.assigned", l.id, { leadId: l.id, processId: l.processId, assignedTo: owner.id, agentName: owner.name, manual: true }));
    await notify(tx, [owner.id], { kind: "lead_assigned", title: `${moving.length} lead${moving.length > 1 ? "s" : ""} assigned to you`, body: `By ${ctx.actor.name}`, link: "/console" });
    await writeAudit(tx, ctx, { action: "leads.bulk_assigned", entity: "lead", entityId: owner.id, after: { count: moving.length, to: owner.id } });
    return { moved: moving.length, skipped, outboxIds };
  });
  await publishOutboxAfterResponse(ctx, res.outboxIds);
  return { moved: res.moved, skipped: res.skipped };
}

/** Move each selected lead to `stage` (the won stage converts). Leads whose process lacks the stage, or are closed, are skipped. */
export async function bulkStage(ctx: SessionContext, input: z.infer<typeof BulkStageInput>) {
  requirePermission(ctx, "leads", "E");
  let moved = 0;
  for (const leadId of input.leadIds) {
    try {
      await setStage(ctx, { leadId, stage: input.stage });
      moved++;
    } catch {
      // closed lead, stage not in its process, or out of scope — reported as skipped
    }
  }
  return { moved, skipped: input.leadIds.length - moved };
}
