/**
 * Job "process-webhook": turn one stored webhook into business changes.
 *
 * Routes by `source`:
 *   "telephony:<provider>"    → adapter.parseWebhook → applyCallEvents
 *   "source:<importSourceId>" → normalise → createOrMergeLead
 *
 * Idempotent: the row moves received → processing → done, and a row already
 * "done" is skipped, so a QStash redelivery is harmless. Errors are recorded
 * on the row and re-thrown so QStash retries; after the last retry the
 * message is in the DLQ and the row stays "failed" for the admin
 * "Failed events" screen (Replay = enqueue this job again).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { importSources, integrations, processes, webhookEvents } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createOrMergeLead } from "@/lib/leads/create";
import { normaliseLead } from "@/lib/leads/normalise";
import { applyCallEvents } from "@/lib/telephony/call-events";
import { telephonyAdapter } from "@/lib/telephony/registry";
import type { TenantContext } from "@/lib/tenancy/context";
import { log } from "@/lib/log";

export async function processWebhook(ctx: TenantContext, webhookEventId: string): Promise<void> {
  // Claim the row. "processing" is re-claimable so a crashed attempt can be retried.
  const [ev] = await withTenant(ctx, (tx) =>
    tx
      .update(webhookEvents)
      .set({ status: "processing", attempts: sql`${webhookEvents.attempts} + 1` })
      .where(and(eq(webhookEvents.id, webhookEventId), inArray(webhookEvents.status, ["received", "failed", "processing"])))
      .returning(),
  );
  if (!ev) return; // already done (or dead)

  try {
    if (ev.source.startsWith("telephony:")) {
      await handleTelephony(ctx, ev.source.slice("telephony:".length), ev.payload);
    } else if (ev.source.startsWith("source:")) {
      await handleLeadSource(ctx, ev.source.slice("source:".length), ev.payload);
    } else {
      throw new Error(`unknown webhook source ${ev.source}`);
    }
    await withTenant(ctx, (tx) => tx.update(webhookEvents).set({ status: "done", error: null }).where(eq(webhookEvents.id, ev.id)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(ctx, (tx) => tx.update(webhookEvents).set({ status: "failed", error: message }).where(eq(webhookEvents.id, ev.id)));
    log.error("webhook processing failed", { tenant: ctx.tenantSlug, source: ev.source, err });
    throw err; // → QStash retry / DLQ
  }
}

async function handleTelephony(ctx: TenantContext, provider: string, payload: Record<string, unknown>) {
  const adapter = telephonyAdapter(provider);
  const found = await withTenant(ctx, async (tx) => {
    const [integration] = await tx
      .select()
      .from(integrations)
      .where(and(eq(integrations.kind, "telephony"), eq(integrations.provider, provider)));
    const dids = integration
      ? await tx.query.telephonyDids.findMany({ where: (d, { eq: e }) => e(d.integrationId, integration.id), columns: { number: true } })
      : [];
    return { integration, dids: dids.map((d) => d.number) };
  });
  if (!found.integration || !adapter) throw new Error(`telephony provider ${provider} not configured`);

  const callEvents = adapter.parseWebhook(payload, { registeredDids: found.dids });
  await applyCallEvents(ctx, found.integration, callEvents);
}

async function handleLeadSource(ctx: TenantContext, sourceId: string, payload: Record<string, unknown>) {
  const row = await withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select({ source: importSources, process: processes })
      .from(importSources)
      .innerJoin(processes, eq(processes.id, importSources.processId))
      .where(eq(importSources.id, sourceId));
    return r;
  });
  if (!row) throw new Error("import source not found");

  // TODO(T2.1): Meta Lead Ads sends only a lead id; fetch the lead from the Graph API first.
  const result = normaliseLead(payload, row.source.fieldMap);
  if (!result.ok) {
    // Bad data is not retryable; record it and stop.
    log.warn("lead rejected", { tenant: ctx.tenantSlug, reason: result.reason });
    return;
  }
  await createOrMergeLead(ctx, row.process, result.lead, { kind: row.source.kind, sourceId: row.source.id });
  await withTenant(ctx, (tx) => tx.update(importSources).set({ lastLeadAt: new Date() }).where(eq(importSources.id, row.source.id)));
}
