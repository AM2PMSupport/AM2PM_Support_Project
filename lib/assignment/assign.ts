/**
 * Assign one lead atomically (job: "assign-lead", DESIGN.md §4).
 *
 * One Postgres transaction (inside withTenant, so RLS applies):
 *   1. SELECT the lead ... FOR UPDATE            → two workers for the same
 *                                                  lead queue up; the second
 *                                                  sees it already assigned.
 *   2. SELECT assignment_state ... FOR UPDATE    → one assignment at a time per
 *                                                  process, so round-robin and
 *                                                  quotas never double-count.
 *   3. Pick candidates (pure methods.ts).
 *   4. UPDATE users SET open_leads = open_leads + 1
 *        WHERE id = $1 AND open_leads < max_open_leads RETURNING
 *      → no row = that agent filled up meanwhile; try the next (max 3).
 *   5. Save state, set leads.assigned_to, lead_events, outbox(lead.assigned).
 *
 * Nobody eligible → the lead stays unassigned; the 5-minute sweeper retries
 * (ARCHITECTURE.md §4). The outbox is published after commit.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { assignmentState, leadEvents, leads, processes, userProcesses, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { eligibleUsers, localParts } from "@/lib/assignment/eligibility";
import { pick, rollDay, type Candidate } from "@/lib/assignment/methods";
import { publishOutboxSafely, writeOutbox } from "@/lib/events/outbox";
import type { TenantContext } from "@/lib/tenancy/context";

const MAX_TRIES = 3;

export type AssignResult =
  | { outcome: "assigned"; userId: string }
  | { outcome: "already_assigned" }
  | { outcome: "no_eligible_agent" }
  | { outcome: "not_found" };

export async function assignLead(ctx: TenantContext, leadId: string, now = new Date()): Promise<AssignResult> {
  const today = localParts(now, ctx.timezone).day;

  const res = await withTenant(ctx, async (tx) => {
    const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId)).for("update");
    if (!lead) return { outcome: "not_found" as const };
    if (lead.assignedTo || lead.status !== "open") return { outcome: "already_assigned" as const };

    const [process] = await tx.select().from(processes).where(eq(processes.id, lead.processId));
    if (!process || process.status !== "active") return { outcome: "no_eligible_agent" as const };

    // First assignment for this process creates its state row.
    await tx.insert(assignmentState).values({ processId: process.id, day: today }).onConflictDoNothing();
    const [saved] = await tx.select().from(assignmentState).where(eq(assignmentState.processId, process.id)).for("update");
    const state = rollDay({ seq: saved!.seq, smoothWeights: saved!.smoothWeights, dailyCounts: saved!.dailyCounts, day: saved!.day }, today);

    // Agents mapped to this process (join table), active and available.
    // TODO(T1.28): cache this list in Redis for 30 s per process.
    const mapped = await tx
      .select({
        id: users.id,
        name: users.name,
        status: users.status,
        isAvailable: users.isAvailable,
        openLeads: users.openLeads,
        maxOpenLeads: users.maxOpenLeads,
        dailyQuota: users.dailyQuota,
        skills: users.skills,
        shareWeight: users.shareWeight,
      })
      .from(users)
      .innerJoin(userProcesses, and(eq(userProcesses.userId, users.id), eq(userProcesses.processId, process.id)))
      .where(and(eq(users.status, "active"), eq(users.isAvailable, true)));

    // TODO(T2.6): sticky owner — prefer the contact's previous owner if eligible.
    const requiredSkills = (process.assignment.skillFields ?? [])
      .map((f) => lead.custom[f.replace(/^custom\./, "")])
      .filter((v): v is string => typeof v === "string");

    const eligible = eligibleUsers({
      assignment: process.assignment,
      users: mapped,
      dailyCounts: state.dailyCounts,
      requiredSkills,
      now,
      timeZone: ctx.timezone,
    });
    const cands: Candidate[] = eligible.map((u) => ({
      id: u.id,
      weight: u.shareWeight,
      openLeads: u.openLeads,
      dailyQuota: u.dailyQuota ?? undefined,
      skills: u.skills,
    }));
    const result = pick(process.assignment.method, cands, state);

    for (const candidate of result.order.slice(0, MAX_TRIES)) {
      // Conditional increment: the capacity check and the claim are one statement.
      const [agent] = await tx
        .update(users)
        .set({ openLeads: sql`${users.openLeads} + 1` })
        .where(and(eq(users.id, candidate), lt(users.openLeads, users.maxOpenLeads)))
        .returning({ id: users.id, name: users.name });
      if (!agent) continue; // filled up since we read it — try the next candidate

      const next = result.next(candidate);
      await tx
        .update(assignmentState)
        .set({ seq: next.seq, smoothWeights: next.smoothWeights, dailyCounts: next.dailyCounts, day: today })
        .where(eq(assignmentState.processId, process.id));
      await tx.update(leads).set({ assignedTo: agent.id, assignedAt: now, slaAlertedAt: null }).where(eq(leads.id, lead.id));
      await tx.insert(leadEvents).values({
        leadId: lead.id,
        type: "assigned",
        actor: { kind: "system", name: process.assignment.method },
        after: { assignedTo: agent.id },
      });
      const outboxId = await writeOutbox(tx, "lead.assigned", lead.id, {
        leadId: lead.id,
        processId: process.id,
        assignedTo: agent.id,
        agentName: agent.name,
      });
      return { outcome: "assigned" as const, userId: agent.id, outboxId };
    }

    // TODO(T1.31): alert the supervisor once the lead has waited > slaMinutes.
    return { outcome: "no_eligible_agent" as const };
  });

  if (res.outcome === "assigned") {
    await publishOutboxSafely(ctx, [res.outboxId]);
    return { outcome: "assigned", userId: res.userId };
  }
  return res;
}
