/**
 * Place an outbound call: POST /api/v1/leads/{id}/call (ARCHITECTURE.md §3.3).
 *
 *   1. (tx) Check the agent may call this lead, the contact is not DNC, and
 *      the agent has a phone + caller-ID DID.
 *   2. Take the one-call-per-agent lock (Redis).
 *   3. (tx) Create the `interactions` row FIRST (status "initiated") so every
 *      provider webhook can be matched by correlation id (RULE.md §6.1.4).
 *   4. Ask the provider to ring the agent's phone, then the customer.
 *      This HTTP call runs outside any database transaction.
 *   5. On provider error: mark the call failed, release the lock, return a
 *      message the agent can act on.
 *
 * Everything after step 4 (ringing, answered, completed, recording) arrives
 * by webhook and is handled in call-events.ts. No voice ever passes through
 * the CRM, and there is no SIP (RULE.md §6.1.1).
 */
import { and, desc, eq, ne } from "drizzle-orm";
import { contacts, integrations, interactions, leads, processes, telephonyDids, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { ApiError, conflict, forbidden, notFound } from "@/lib/http/errors";
import type { SessionContext } from "@/lib/auth/session";
import { telephonyAdapter } from "@/lib/telephony/registry";
import { acquireCallLock, releaseCallLock } from "@/lib/telephony/lock";
import { log } from "@/lib/log";

export interface PlaceCallResult {
  interactionId: string;
  status: "initiated";
}

export async function placeCall(ctx: SessionContext, leadId: string): Promise<PlaceCallResult> {
  const userId = ctx.actor.userId;

  // Step 1: load and validate everything in one short transaction.
  const plan = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ lead: leads, contact: contacts, process: processes })
      .from(leads)
      .innerJoin(contacts, eq(contacts.id, leads.contactId))
      .innerJoin(processes, eq(processes.id, leads.processId))
      .where(eq(leads.id, leadId));
    if (!row) throw notFound("Lead not found");
    const { lead, contact, process } = row;

    // TODO(T1.14): full scope resolver (team/process scopes for supervisors).
    if (ctx.actor.role === "agent" && lead.assignedTo !== userId) throw forbidden("This lead is not assigned to you");
    if (contact.dnc || lead.status === "dnc") throw forbidden("This contact is on Do Not Call", "dnc");
    if (!contact.phoneE164) throw new ApiError(422, "no_phone", "This contact has no phone number");

    const [agent] = await tx.select().from(users).where(eq(users.id, userId));
    if (!agent?.agentPhoneE164 || !agent.agentPhone10) {
      throw new ApiError(422, "no_agent_phone", "Your phone number is not set up. Ask your admin.");
    }

    const [integration] = await tx
      .select()
      .from(integrations)
      .where(and(eq(integrations.kind, "telephony"), eq(integrations.status, "active")))
      .limit(1);
    if (!integration || !telephonyAdapter(integration.provider)) {
      throw new ApiError(422, "no_telephony", "Calling is not set up for this client.");
    }

    // Caller ID: the agent's own DID, else the process default outbound DID.
    const [did] = await tx
      .select({ number: telephonyDids.number })
      .from(telephonyDids)
      .where(and(eq(telephonyDids.processId, process.id), ne(telephonyDids.direction, "inbound")))
      .orderBy(desc(telephonyDids.defaultForOutbound))
      .limit(1);
    const callerId = agent.did ?? did?.number;
    if (!callerId) throw new ApiError(422, "no_did", "No caller-ID number (DID) is set for this process.");

    return { lead, contact, process, agent, integration, callerId };
  });

  const adapter = telephonyAdapter(plan.integration.provider)!;
  const correlationId = crypto.randomUUID();

  // Step 2: one live call per agent.
  if (!(await acquireCallLock(ctx.tenantId, userId, correlationId))) {
    throw conflict("You are already on a call. Finish it and set the disposition first.", "already_on_call");
  }

  // Step 3: record first, so webhooks always find the call.
  let interactionId: string;
  try {
    interactionId = await withTenant(ctx, async (tx) => {
      const [row] = await tx
        .insert(interactions)
        .values({
          type: "call",
          direction: "outbound",
          leadId: plan.lead.id,
          contactId: plan.contact.id,
          processId: plan.process.id,
          agentId: plan.agent.id,
          agentName: plan.agent.name,
          status: "initiated",
          provider: adapter.name,
          correlationId,
          did: plan.callerId,
          agentNumber: plan.agent.agentPhone10,
          customerNumber: plan.contact.phoneE164,
        })
        .returning({ id: interactions.id });
      return row!.id;
    });
  } catch (err) {
    await releaseCallLock(ctx.tenantId, userId, correlationId); // don't leave the agent locked out
    throw err;
  }

  // Step 4: ask the provider to ring the agent, then the customer.
  const creds = JSON.parse(decrypt(plan.integration.credentialsEnc)) as Record<string, string>;
  const result = await adapter.clickToCall(
    { agentNumber: plan.agent.agentPhoneE164!, customerNumber: plan.contact.phoneE164!, callerId: plan.callerId, correlationId },
    creds,
  );

  if (!result.ok) {
    // Step 5: fail cleanly so the agent can retry.
    await withTenant(ctx, (tx) =>
      tx.update(interactions).set({ status: "failed", endedAt: new Date(), endReason: result.code }).where(eq(interactions.id, interactionId)),
    );
    await releaseCallLock(ctx.tenantId, userId, correlationId);
    log.warn("click-to-call rejected", { tenant: ctx.tenantSlug, code: result.code });
    throw new ApiError(502, result.code, result.message);
  }

  if (result.providerCallId) {
    await withTenant(ctx, (tx) =>
      tx.update(interactions).set({ providerCallId: result.providerCallId }).where(eq(interactions.id, interactionId)),
    );
  }
  return { interactionId, status: "initiated" };
}
