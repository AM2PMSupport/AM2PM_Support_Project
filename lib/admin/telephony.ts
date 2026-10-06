/**
 * Telephony setup — Setup (T1.37b). Click-to-call only (no SIP).
 *
 * - CallerDesk credentials: encrypted (AES-256-GCM) at rest, never returned.
 * - Webhook secret: generated here, shown ONCE inside the webhook URL to
 *   paste into CallerDesk; stored encrypted (the adapter compares it).
 * - DIDs: each number maps to exactly one process (RULE.md §6.1.7).
 * - Test call: rings the agent's own phone through the provider to prove
 *   the number works, then marks it verified.
 */
import { rejectedWebhooks } from "@/lib/http/rate-limit";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { integrations, processes, telephonyDids, users, webhookEvents } from "@/lib/db/schema";
import { isUniqueViolation, withTenant } from "@/lib/db/tenant";
import { isLocalUrl, publicBaseUrl } from "@/lib/config/env";
import { decrypt, encrypt, randomToken } from "@/lib/crypto";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { ApiError, badRequest, conflict, notFound } from "@/lib/http/errors";
import { digitsOnly } from "@/lib/phone/phone";
import { telephonyAdapter } from "@/lib/telephony/registry";

const PROVIDER = "callerdesk";

export function telephonyWebhookUrl(tenantSlug: string, secret: string) {
  // Secret in the PATH, not ?key=: CallerDesk was seen rejecting/dropping the
  // query string on POST (all events 401). Secrets are base64url (URL-safe).
  return `${publicBaseUrl()}/api/hooks/${tenantSlug}/telephony/${PROVIDER}/${secret}`;
}

export async function getTelephony(ctx: SessionContext) {
  requirePermission(ctx, "config", "V");
  // Webhooks CallerDesk sent with a wrong key today (old URL still in CallerDesk) — Redis, outside the transaction.
  const rejected = await rejectedWebhooks(ctx.tenantId, `telephony:${PROVIDER}`);
  return withTenant(ctx, async (tx) => {
    const [integration] = await tx.select().from(integrations).where(eq(integrations.kind, "telephony"));
    const dids = await tx
      .select({ did: telephonyDids, processName: processes.name })
      .from(telephonyDids)
      .innerJoin(processes, eq(processes.id, telephonyDids.processId))
      .orderBy(asc(telephonyDids.number));
    // Is CallerDesk actually reaching us? Last event + recent failures.
    const [hook] = await tx
      .select({
        last: sql<Date | null>`max(${webhookEvents.createdAt})`,
        today: sql<number>`count(*) filter (where ${webhookEvents.createdAt} > now() - interval '24 hours')::int`,
        failed: sql<number>`count(*) filter (where ${webhookEvents.status} in ('failed','dead') and ${webhookEvents.createdAt} > now() - interval '24 hours')::int`,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.source, `telephony:${PROVIDER}`));
    const [lastError] = await tx
      .select({ error: webhookEvents.error })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.source, `telephony:${PROVIDER}`), inArray(webhookEvents.status, ["failed", "dead"])))
      .orderBy(desc(webhookEvents.createdAt))
      .limit(1);
    const base = publicBaseUrl();
    return {
      connected: !!integration,
      webhookHealth: {
        lastAt: hook?.last ? new Date(hook.last).toISOString() : null,
        last24h: hook?.today ?? 0,
        failed24h: hook?.failed ?? 0,
        lastError: lastError?.error?.slice(0, 200) ?? null,
      },
      // A localhost webhook URL can never be reached by CallerDesk.
      webhookBaseIsLocal: isLocalUrl(base),
      provider: integration?.provider ?? null,
      status: integration?.status ?? null,
      /** Scheduled 15-min call-report sync (Setup toggle); default on. */
      syncCalls: integration?.config?.syncCalls !== false,
      rejected,
      hasWebhookSecret: !!integration?.webhookSecretEnc,
      maskedWebhookUrl: integration?.webhookSecretEnc ? telephonyWebhookUrl(ctx.tenantSlug, "••••••") : null,
      dids: dids.map((d) => ({ ...d.did, processName: d.processName })),
    };
  });
}

export const CredentialsInput = z.object({ authCode: z.string().trim().min(8).max(200) });

/** Save CallerDesk credentials and (first time) create the webhook secret. Returns the secret URL once. */
export async function saveCallerDesk(ctx: SessionContext, input: z.infer<typeof CredentialsInput>): Promise<{ webhookUrl: string | null }> {
  requirePermission(ctx, "integrations", "C");
  const credentialsEnc = encrypt(JSON.stringify({ authCode: input.authCode }));
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx.select().from(integrations).where(eq(integrations.kind, "telephony"));
    let secret: string | null = null;
    if (existing) {
      await tx.update(integrations).set({ credentialsEnc, status: "active" }).where(eq(integrations.id, existing.id));
    } else {
      secret = randomToken(24);
      await tx.insert(integrations).values({ kind: "telephony", provider: PROVIDER, credentialsEnc, webhookSecretEnc: encrypt(secret), status: "active" });
    }
    await writeAudit(tx, ctx, { action: "telephony.credentials_saved", entity: "integration", entityId: existing?.id ?? null });
    return { webhookUrl: secret ? telephonyWebhookUrl(ctx.tenantSlug, secret) : null };
  });
}

export async function rotateWebhookSecret(ctx: SessionContext): Promise<{ webhookUrl: string }> {
  requirePermission(ctx, "integrations", "E");
  const secret = randomToken(24);
  await withTenant(ctx, async (tx) => {
    const [i] = await tx.update(integrations).set({ webhookSecretEnc: encrypt(secret) }).where(eq(integrations.kind, "telephony")).returning({ id: integrations.id });
    if (!i) throw notFound("Connect CallerDesk first");
    await writeAudit(tx, ctx, { action: "telephony.webhook_secret_rotated", entity: "integration", entityId: i.id });
  });
  return { webhookUrl: telephonyWebhookUrl(ctx.tenantSlug, secret) };
}

export const DidInput = z.object({
  number: z.string().trim().min(8).max(20),
  processId: z.uuid(),
  direction: z.enum(["inbound", "outbound", "both"]),
  defaultForOutbound: z.boolean().default(false),
});

export async function addDid(ctx: SessionContext, input: z.infer<typeof DidInput>) {
  requirePermission(ctx, "integrations", "C");
  const digits = digitsOnly(input.number);
  if (digits.length < 10) throw badRequest("Enter the full DID number");
  try {
    return await withTenant(ctx, async (tx) => {
      const [integration] = await tx.select({ id: integrations.id }).from(integrations).where(eq(integrations.kind, "telephony"));
      if (!integration) throw conflict("Connect CallerDesk before adding numbers", "no_integration");
      const [d] = await tx
        .insert(telephonyDids)
        // Keep the number exactly as typed (CallerDesk needs the leading 0).
        .values({ integrationId: integration.id, number: digits, number10: digits.slice(-10), processId: input.processId, direction: input.direction, defaultForOutbound: input.defaultForOutbound })
        .returning();
      await writeAudit(tx, ctx, { action: "telephony.did_added", entity: "telephony_did", entityId: d!.id, after: { last4: digits.slice(-4) } });
      return d!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("That number is already mapped");
    throw err;
  }
}

export async function removeDid(ctx: SessionContext, id: string) {
  requirePermission(ctx, "integrations", "D");
  return withTenant(ctx, async (tx) => {
    await tx.delete(telephonyDids).where(eq(telephonyDids.id, id));
    await writeAudit(tx, ctx, { action: "telephony.did_removed", entity: "telephony_did", entityId: id });
  });
}

/** Ring an agent's own phone through CallerDesk; on success mark it verified. */
export async function testAgentPhone(ctx: SessionContext, userId: string) {
  requirePermission(ctx, "users", "E");
  const plan = await withTenant(ctx, async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId));
    const [integration] = await tx.select().from(integrations).where(eq(integrations.kind, "telephony"));
    const [did] = await tx.select({ number: telephonyDids.number }).from(telephonyDids).limit(1);
    return { u, integration, did: u?.did ?? did?.number };
  });
  if (!plan.u?.agentPhoneE164) throw badRequest("Add the agent's phone number first");
  if (!plan.integration) throw conflict("Connect CallerDesk first", "no_integration");
  if (!plan.did) throw conflict("Add a DID number first", "no_did");
  const adapter = telephonyAdapter(plan.integration.provider)!;
  const creds = JSON.parse(decrypt(plan.integration.credentialsEnc)) as Record<string, string>;
  const res = await adapter.clickToCall(
    { agentNumber: plan.u.agentPhoneE164, customerNumber: plan.u.agentPhoneE164, callerId: plan.did, correlationId: `verify-${userId}-${Date.now()}` },
    creds,
  );
  if (!res.ok) throw new ApiError(502, res.code, res.message);
  await withTenant(ctx, async (tx) => {
    await tx.update(users).set({ agentPhoneVerifiedAt: new Date() }).where(eq(users.id, userId));
    await writeAudit(tx, ctx, { action: "user.phone_verified", entity: "user", entityId: userId });
  });
  return { ok: true };
}

/** Setup → Telephony: switch the scheduled 15-min call-report sync on or off ("Sync now" still works). */
export async function setCallSync(ctx: SessionContext, on: boolean): Promise<void> {
  requirePermission(ctx, "integrations", "E");
  await withTenant(ctx, async (tx) => {
    const [i] = await tx
      .update(integrations)
      .set({ config: sql`${integrations.config} || ${JSON.stringify({ syncCalls: on })}::jsonb` })
      .where(eq(integrations.kind, "telephony"))
      .returning({ id: integrations.id });
    if (!i) throw notFound("Connect CallerDesk first");
    await writeAudit(tx, ctx, { action: on ? "telephony.call_sync_on" : "telephony.call_sync_off", entity: "integration", entityId: i.id });
  });
}
