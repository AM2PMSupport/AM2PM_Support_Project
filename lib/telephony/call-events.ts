/**
 * Apply provider call webhooks — inbound AND outbound (DESIGN.md §5.2–5.3).
 *
 * Called by the "process-webhook" job after the raw payload was stored in
 * `webhook_events`. For each normalised event:
 *
 *   1. Find the call: by correlation id → provider call id → (outbound) the
 *      agent's latest open call to that customer.
 *   2. No call found and direction is inbound → a NEW inbound call:
 *      DID → process (telephony_dids), find/create contact + lead, create the
 *      interaction.
 *   3. Move the status with the state machine (never backwards). The UPDATE
 *      is guarded on the status we read, so racing webhooks apply once.
 *   4. Side effects, in the same transaction as the status change:
 *        answered → leads.attempts + 1
 *        terminal + connected → outbox call.completed
 *        inbound missed → callback due now (max one per lead per tenant-local
 *                         day, enforced by a unique index) + outbox call.missed
 *      After commit (never inside a transaction): Redis presence + call lock,
 *      publish the outbox, queue "copy-recording".
 */
import { and, desc, eq, gte, lte, notInArray, sql } from "drizzle-orm";
import { callbacks, interactions, leads, processes, telephonyDids, users, type Integration, type Interaction } from "@/lib/db/schema";
import { withTenant, type Tx } from "@/lib/db/tenant";
import { localParts } from "@/lib/assignment/eligibility";
import { publishOutboxSafely, writeOutbox } from "@/lib/events/outbox";
import { createOrMergeLead } from "@/lib/leads/create";
import { phoneKey, toE164, toTenDigits } from "@/lib/phone/phone";
import { enqueue } from "@/lib/queue/qstash";
import { keys, redis } from "@/lib/redis/client";
import { releaseCallLock } from "@/lib/telephony/lock";
import { isAllowedRecordingUrl } from "@/lib/telephony/recordings";
import { nextInboundStatus, nextOutboundStatus, OUTBOUND_TERMINAL, wasConnected } from "@/lib/telephony/state-machine";
import type { NormalisedCallEvent } from "@/lib/telephony/types";
import type { InboundCallStatus, OutboundCallStatus } from "@/lib/db/schema";
import type { TenantContext } from "@/lib/tenancy/context";
import { log } from "@/lib/log";

/** How far back to look when matching an outbound webhook without ids. */
/** Number-based matching looks back this far from the event (long calls; synced reports). */
const MATCH_WINDOW_MS = 3 * 60 * 60 * 1000;
/** Calls a late real result may still match: open ones, plus the sweeper's / agent's "unknown". */
const MATCHABLE_CLOSED = [...OUTBOUND_TERMINAL].filter((s) => s !== "unknown");
const TERMINAL = new Set(["completed", "missed", "agent_no_answer", "busy", "no_answer", "failed"]);
const PRESENCE_TTL = 4 * 60 * 60;

export async function applyCallEvents(ctx: TenantContext, integration: Integration, events: NormalisedCallEvent[]): Promise<void> {
  for (const ev of events) await applyOne(ctx, integration, ev);
}

async function findCall(tx: Tx, provider: string, ev: NormalisedCallEvent): Promise<Interaction | undefined> {
  if (ev.correlationId) {
    const [c] = await tx.select().from(interactions).where(eq(interactions.correlationId, ev.correlationId));
    if (c) return c;
  }
  if (ev.providerCallId) {
    const [c] = await tx
      .select()
      .from(interactions)
      .where(and(eq(interactions.provider, provider), eq(interactions.providerCallId, ev.providerCallId)));
    if (c) return c;
  }
  if (ev.direction === "outbound" && ev.agentNumber) {
    // Fallback: this agent's most recent open call to this customer.
    const [c] = await tx
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.type, "call"),
          eq(interactions.direction, "outbound"),
          eq(interactions.agentNumber, ev.agentNumber),
          eq(interactions.customerNumber, toE164(ev.customerNumber) ?? ev.customerNumber),
          gte(interactions.startedAt, new Date(ev.at.getTime() - MATCH_WINDOW_MS)),
          lte(interactions.startedAt, new Date(ev.at.getTime() + 5 * 60_000)),
          // A recording always arrives after the call ended, so it may match a finished call.
          ev.kind === "recording_ready" ? undefined : notInArray(interactions.status, MATCHABLE_CLOSED),
        ),
      )
      .orderBy(desc(interactions.startedAt))
      .limit(1);
    if (c) return c;
  }
  return undefined;
}

/** A new inbound call: resolve process from the DID, then lead, agent and call row. */
async function createInboundCall(ctx: TenantContext, integration: Integration, ev: NormalisedCallEvent): Promise<Interaction | undefined> {
  const route = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ process: processes })
      .from(telephonyDids)
      .innerJoin(processes, eq(processes.id, telephonyDids.processId))
      .where(and(eq(telephonyDids.number10, toTenDigits(ev.did)), eq(telephonyDids.integrationId, integration.id)));
    return row;
  });
  // RULE.md §6.1.7: never guess the process. The job fails → visible in "Failed events".
  if (!route) throw new Error(`inbound call on unmapped DID ending ${ev.did.slice(-4)}`);

  const key = phoneKey(ev.customerNumber);
  const e164 = toE164(ev.customerNumber) ?? undefined;
  const { leadId } = await createOrMergeLead(ctx, route.process, { phoneKey: key || undefined, phoneE164: e164, custom: {} }, { kind: "inbound_call" });

  const correlationId = `in:${integration.provider}:${ev.providerCallId ?? `${key}:${ev.at.getTime()}`}`;
  return withTenant(ctx, async (tx) => {
    const [lead] = await tx.select({ contactId: leads.contactId }).from(leads).where(eq(leads.id, leadId));
    const [agent] = ev.agentNumber
      ? await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.agentPhone10, toTenDigits(ev.agentNumber)))
      : [];
    // ON CONFLICT: a parallel webhook for the same call may have created it first.
    await tx
      .insert(interactions)
      .values({
        type: "call",
        direction: "inbound",
        leadId,
        contactId: lead?.contactId,
        processId: route.process.id,
        agentId: agent?.id,
        agentName: agent?.name,
        status: "ringing",
        startedAt: ev.at,
        provider: integration.provider,
        providerCallId: ev.providerCallId,
        correlationId,
        did: ev.did,
        agentNumber: ev.agentNumber,
        customerNumber: e164 ?? ev.customerNumber,
      })
      .onConflictDoNothing();
    const [call] = await tx.select().from(interactions).where(eq(interactions.correlationId, correlationId));
    return call;
  });
}

async function applyOne(ctx: TenantContext, integration: Integration, ev: NormalisedCallEvent): Promise<void> {
  let call = await withTenant(ctx, (tx) => findCall(tx, integration.provider, ev));
  if (!call && ev.direction === "inbound") call = await createInboundCall(ctx, integration, ev);
  if (!call) {
    log.warn("call webhook matched no call", { tenant: ctx.tenantSlug, kind: ev.kind, direction: ev.direction });
    return;
  }
  const found = call;

  if (ev.kind === "recording_ready" && ev.recordingUrl) {
    // Already known (repeat webhook or the 15-min sync): only re-queue the copy
    // if it never completed (e.g. the job failed); otherwise nothing to do.
    if (found.recordingUrl === ev.recordingUrl) {
      if (!found.recordingKey && isAllowedRecordingUrl(ev.recordingUrl)) {
        await enqueue("copy-recording", { tenantId: ctx.tenantId, interactionId: found.id }, { deduplicationId: `rec:${found.id}` });
      }
      return;
    }
    await withTenant(ctx, (tx) => tx.update(interactions).set({ recordingUrl: ev.recordingUrl }).where(eq(interactions.id, found.id)));
    await enqueue("copy-recording", { tenantId: ctx.tenantId, interactionId: found.id }, { deduplicationId: `rec:${found.id}` });
    return;
  }

  const next =
    found.direction === "outbound"
      ? nextOutboundStatus(found.status as OutboundCallStatus, ev.kind)
      : nextInboundStatus(found.status as InboundCallStatus, ev.kind);
  if (!next) return; // duplicate or out-of-order webhook: nothing to do

  const outcome = await withTenant(ctx, async (tx) => {
    // Inbound: learn who answered, if this webhook tells us.
    let agentId = found.agentId;
    if (!agentId && ev.agentNumber) {
      const [agent] = await tx.select({ id: users.id }).from(users).where(eq(users.agentPhone10, toTenDigits(ev.agentNumber)));
      agentId = agent?.id ?? null;
    }
    const terminal = TERMINAL.has(next);

    const [updated] = await tx
      .update(interactions)
      .set({
        status: next,
        agentId,
        ...(terminal ? { endedAt: ev.at } : {}),
        ...(ev.durationSec ? { durationSec: ev.durationSec } : {}),
        ...(ev.talkSec ? { talkSec: ev.talkSec } : {}),
        ...(ev.hangupBy ? { hangupBy: ev.hangupBy } : {}),
      })
      .where(and(eq(interactions.id, found.id), eq(interactions.status, found.status)))
      .returning({ id: interactions.id });
    if (!updated) return undefined; // another webhook won the race; it owns the side effects

    const outboxIds: string[] = [];
    const payload = {
      interactionId: found.id,
      leadId: found.leadId,
      processId: found.processId,
      direction: found.direction,
      status: next,
      durationSec: ev.durationSec,
      agentId,
    };

    if (next === "answered" && found.leadId) {
      await tx.update(leads).set({ attempts: sql`${leads.attempts} + 1`, lastInteractionAt: ev.at }).where(eq(leads.id, found.leadId));
    }
    if (terminal && wasConnected(next)) {
      outboxIds.push(await writeOutbox(tx, "call.completed", found.id, payload));
    }
    if (found.direction === "inbound" && next === "missed" && found.leadId) {
      await createMissedCallCallback(tx, ctx, found.leadId, ev.at);
      outboxIds.push(await writeOutbox(tx, "call.missed", found.id, payload));
    }
    return { agentId, terminal, outboxIds };
  });
  if (!outcome) return;

  // After commit: live state and fan-out.
  if (outcome.agentId) {
    if (next === "answered") {
      await redis().set(keys.presence(ctx.tenantId, outcome.agentId), "on_call", { ex: PRESENCE_TTL });
      // TODO(T1.40): push a screen-pop (inbound) / "Connected" (outbound) to the agent's SSE stream.
    } else if (outcome.terminal) {
      await releaseCallLock(ctx.tenantId, outcome.agentId, found.correlationId ?? found.id);
      await redis().set(keys.presence(ctx.tenantId, outcome.agentId), "wrap_up", { ex: PRESENCE_TTL });
    }
  }
  await publishOutboxSafely(ctx, outcome.outboxIds);
}

/** One missed-call callback per lead per tenant-local day (crmv7 missedCallDateKey_). */
async function createMissedCallCallback(tx: Tx, ctx: TenantContext, leadId: string, at: Date): Promise<void> {
  const [lead] = await tx.select({ assignedTo: leads.assignedTo }).from(leads).where(eq(leads.id, leadId));
  // Unique index callbacks_missed_once_a_day makes a second insert the same day a no-op.
  await tx
    .insert(callbacks)
    .values({
      leadId,
      // No owner yet → null; the assignment job gives the lead (and callback) an owner.
      assignedTo: lead?.assignedTo ?? null,
      dueAt: at,
      channel: "call",
      reason: "missed_call",
      day: localParts(at, ctx.timezone).day,
    })
    .onConflictDoNothing();
  await tx.update(leads).set({ nextCallbackAt: at }).where(eq(leads.id, leadId));
}
