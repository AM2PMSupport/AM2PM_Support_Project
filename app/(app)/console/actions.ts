"use server";

/**
 * Console server actions: queue, lead, click-to-call, live call status,
 * outcome, stage, availability. All run as the signed-in user under RLS and
 * the role's lead scope.
 */
import { z, ZodError } from "zod";
import { getSession, type SessionContext } from "@/lib/auth/session";
import { ApiError } from "@/lib/http/errors";
import { log } from "@/lib/log";
import { getLeadDetail, getQueue } from "@/lib/agent/queue";
import { endMyStuckCall, getMyLiveCall, OutcomeInput, saveOutcome, setStage, StageInput } from "@/lib/agent/outcome";
import { EditLeadInput, updateLead } from "@/lib/leads/edit";
import { LeadQuery } from "@/lib/leads/list";
import { and, eq, inArray } from "drizzle-orm";
import { userProcesses, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { canReassign } from "@/lib/auth/rbac";
import { placeCall } from "@/lib/telephony/click-to-call";
import { setMyAvailability } from "@/lib/admin/users";
import { keys, redis } from "@/lib/redis/client";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: (ctx: SessionContext) => Promise<T>): Promise<Result<T>> {
  const ctx = await getSession();
  if (!ctx) return { ok: false, error: "Your session has ended. Sign in again." };
  try {
    return { ok: true, data: await fn(ctx) };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Invalid input" };
    log.error("console action failed", { err });
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

const Id = z.uuid();

/** Queue with the console's filters (same params as the Leads screen, incl. cf_* custom-field filters). */
export const queueAction = async (filters: unknown = {}) =>
  run((ctx) => {
    const f = z.record(z.string().max(60), z.string().max(2000)).parse(filters ?? {});
    LeadQuery.parse(f); // reject bad params with a readable error
    return getQueue(ctx, 150, f);
  });
export const leadAction = async (id: unknown) => run((ctx) => getLeadDetail(ctx, Id.parse(id)));
export const startCallAction = async (leadId: unknown, number: unknown = "primary") =>
  run((ctx) => placeCall(ctx, Id.parse(leadId), z.enum(["primary", "alt"]).parse(number)));
export const callStatusAction = async (interactionId?: unknown) =>
  run((ctx) => getMyLiveCall(ctx, interactionId ? Id.parse(interactionId) : undefined));
// Save/stage return the refreshed lead so the browser doesn't need a second round trip.
export const saveOutcomeAction = async (input: unknown) =>
  run(async (ctx) => {
    const data = OutcomeInput.parse(input);
    await saveOutcome(ctx, data);
    return getLeadDetail(ctx, data.leadId);
  });
export const setStageAction = async (input: unknown) =>
  run(async (ctx) => {
    const data = StageInput.parse(input);
    await setStage(ctx, data);
    return getLeadDetail(ctx, data.leadId);
  });
export const setAvailabilityAction = async (available: unknown) =>
  run(async (ctx) => {
    const on = z.boolean().parse(available);
    await setMyAvailability(ctx, on);
    // Presence for the Floor board; harmless if Redis is briefly unavailable.
    await redis()
      .set(keys.presence(ctx.tenantId, ctx.actor.userId), on ? "available" : "break", { ex: 12 * 60 * 60 })
      .catch(() => undefined);
    return { available: on };
  });

// ── Inline detail editing in the console ─────────────────────────────────────
export const updateLeadDetailsAction = async (input: z.input<typeof EditLeadInput>) =>
  run(async (ctx) => {
    await updateLead(ctx, input);
    return getLeadDetail(ctx, input.leadId);
  });

/** Agents who can own a lead of this process (for the owner dropdown); empty if the role can't reassign. */
export const processOwnersAction = async (processId: unknown) =>
  run(async (ctx) => {
    if (!canReassign(ctx.actor.role)) return [];
    const pid = Id.parse(processId);
    return withTenant(ctx, (tx) =>
      tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .innerJoin(userProcesses, eq(userProcesses.userId, users.id))
        .where(and(eq(userProcesses.processId, pid), eq(users.status, "active"), inArray(users.role, ["agent", "process_coordinator"])))
        .orderBy(users.name),
    );
  });

export const endStuckCallAction = async () => run((ctx) => endMyStuckCall(ctx));
