/**
 * Calls sync — fill in what webhooks missed.
 *
 * Pulls the provider's Call Report (CallerDesk call_list_v2: every call of a
 * day with result, durations and recording) and feeds each row through the
 * SAME parser and state machine as webhooks (parseWebhook → applyCallEvents).
 * Idempotent: statuses only move forward, inbound calls dedupe on the
 * provider call id, recordings are copied once. Runs from the 5-min tick
 * (lib/jobs/handlers.ts, clients in turn within a time budget, or one job per
 * client with QUEUE_FANOUT=1) and from the Calls screen's "Sync now".
 *
 * Scale (200–300 clients): the report is re-read every run, but rows whose
 * call is already settled (terminal status, recording copied) are skipped
 * with ONE lookup per page instead of one transaction per row, and a
 * `deadline` stops the run cleanly so the shared 60 s job never times out.
 */
import { and, eq, inArray } from "drizzle-orm";
import { integrations, interactions, telephonyDids } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { TenantContext } from "@/lib/tenancy/context";
import { decrypt } from "@/lib/crypto";
import { telephonyAdapter } from "@/lib/telephony/registry";
import { applyCallEvents, TERMINAL } from "@/lib/telephony/call-events";
import { keys, redis } from "@/lib/redis/client";
import { sha256Hex } from "@/lib/crypto";
import { log } from "@/lib/log";

const MAX_PAGES = 400; // 10,000 calls per client per day; the deadline usually stops first
/**
 * Rows that failed (e.g. an inbound call on a DID not mapped to a process) are
 * retried hourly, not every tick: each failure costs a full transaction, and
 * a handful of them every 5 minutes ate the shared tick budget. Mapping the
 * DID picks them up within the hour.
 */
const FAILED_RETRY_S = 3600;
const failedKey = (tenantId: string, date: string) => `t:${tenantId}:calls:failed:${date}`;

/** IST calendar dates (yyyy-mm-dd) to sync: today, plus yesterday shortly after midnight. */
export function syncDates(now = new Date(), timeZone = "Asia/Kolkata"): string[] {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(now));
  const dates = [fmt(now)];
  if (hour < 2) dates.push(fmt(new Date(now.getTime() - 86_400_000)));
  return dates;
}

export interface SyncResult {
  rows: number;
  failed: number;
  /** Rows skipped because their call was already settled. */
  skipped?: number;
  /** True when the deadline stopped the run before the whole report was read. */
  partial?: boolean;
  at: string;
}

export async function syncCalls(
  ctx: TenantContext,
  dates = syncDates(new Date(), ctx.timezone),
  opts: { deadline?: number } = {},
): Promise<SyncResult | null> {
  const found = await withTenant(ctx, async (tx) => {
    const [integration] = await tx.select().from(integrations).where(and(eq(integrations.kind, "telephony"), eq(integrations.status, "active")));
    const dids = integration ? await tx.select({ n: telephonyDids.number }).from(telephonyDids).where(eq(telephonyDids.integrationId, integration.id)) : [];
    return { integration, dids: dids.map((d) => d.n) };
  });
  const adapter = found.integration ? telephonyAdapter(found.integration.provider) : undefined;
  if (!found.integration || !adapter?.fetchCallReportPage) return null;
  const integration = found.integration;
  const creds = JSON.parse(decrypt(integration.credentialsEnc)) as Record<string, string>;
  const late = () => opts.deadline !== undefined && Date.now() > opts.deadline;

  let rows = 0;
  let failed = 0;
  let skipped = 0;
  let partial = false;
  for (const date of dates) {
    const all: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (late()) {
        partial = true;
        break;
      }
      const r = await adapter.fetchCallReportPage(creds, { date, page });
      all.push(...r.rows);
      if (r.lastPage) break;
    }
    // Oldest first so number-matching pairs each report with the right call.
    all.sort((a, b) => String(a.StartTime ?? "").localeCompare(String(b.StartTime ?? "")));
    const parsed = all.map((payload) => adapter.parseWebhook(payload, { registeredDids: found.dids }));
    const settled = await settledCalls(ctx, integration.provider, parsed.flat().map((e) => e.providerCallId).filter((id): id is string => !!id));
    const failedBefore = new Set(await redis().get<string[]>(failedKey(ctx.tenantId, date)).catch(() => null) ?? []);
    const failedNow = new Set<string>();
    for (let i = 0; i < parsed.length; i++) {
      if (late()) {
        partial = true;
        break;
      }
      const events = parsed[i]!;
      rows++;
      const fp = sha256Hex(JSON.stringify(all[i])).slice(0, 16);
      if (isSettled(events, settled) || failedBefore.has(fp)) {
        skipped++;
        if (failedBefore.has(fp)) failedNow.add(fp);
        continue;
      }
      try {
        await applyCallEvents(ctx, integration, events, "sync");
      } catch (err) {
        failed++; // e.g. an incoming call on a DID not mapped to a process
        failedNow.add(fp);
        log.warn("call sync row failed", { tenant: ctx.tenantSlug, err });
      }
    }
    // Only NEW failures restart the hour; remembered ones keep their original expiry.
    if (failedNow.size > failedBefore.size || [...failedNow].some((f) => !failedBefore.has(f))) {
      await redis().set(failedKey(ctx.tenantId, date), [...failedNow], { ex: FAILED_RETRY_S }).catch(() => undefined);
    }
    if (partial) break;
  }
  const result = { rows, failed, skipped, partial, at: new Date().toISOString() };
  await redis().set(keys.callsSync(ctx.tenantId), JSON.stringify(result), { ex: 7 * 86_400 }).catch(() => undefined);
  return result;
}

type Settled = Map<string, { status: string; copied: boolean }>;

/** Calls already in the database, by provider call id — one query per run (chunked). */
async function settledCalls(ctx: TenantContext, provider: string, ids: string[]): Promise<Settled> {
  const out: Settled = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const found = await withTenant(ctx, (tx) =>
      tx
        .select({ id: interactions.providerCallId, status: interactions.status, key: interactions.recordingKey })
        .from(interactions)
        .where(and(eq(interactions.provider, provider), inArray(interactions.providerCallId, chunk))),
    );
    for (const f of found) if (f.id) out.set(f.id, { status: f.status, copied: !!f.key });
  }
  return out;
}

/**
 * A report row needs no work when its call is terminal and, if the row
 * carries a recording, that recording is already copied (an uncopied one is
 * re-queued by applyCallEvents — QStash drops the duplicate).
 */
export function isSettled(events: { providerCallId?: string; recordingUrl?: string }[], settled: Settled): boolean {
  if (!events.length) return false;
  return events.every((e) => {
    const s = e.providerCallId ? settled.get(e.providerCallId) : undefined;
    return !!s && TERMINAL.has(s.status) && (!e.recordingUrl || s.copied);
  });
}

export async function lastSync(tenantId: string): Promise<SyncResult | null> {
  const v = await redis().get<SyncResult | string>(keys.callsSync(tenantId)).catch(() => null);
  if (!v) return null;
  return typeof v === "string" ? (JSON.parse(v) as SyncResult) : v;
}
