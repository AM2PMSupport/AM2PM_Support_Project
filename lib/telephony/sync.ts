/**
 * Calls sync — fill in what webhooks missed.
 *
 * Pulls the provider's Call Report (CallerDesk call_list_v2: every call of a
 * day with result, durations and recording) and feeds each row through the
 * SAME parser and state machine as webhooks (parseWebhook → applyCallEvents).
 * Idempotent: statuses only move forward, inbound calls dedupe on the
 * provider call id, recordings are copied once. Runs every 15 min (QStash
 * schedule "sync-calls") and from the Calls screen's "Sync now".
 */
import { and, eq } from "drizzle-orm";
import { integrations, telephonyDids } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { TenantContext } from "@/lib/tenancy/context";
import { decrypt } from "@/lib/crypto";
import { telephonyAdapter } from "@/lib/telephony/registry";
import { applyCallEvents } from "@/lib/telephony/call-events";
import { keys, redis } from "@/lib/redis/client";
import { log } from "@/lib/log";

const MAX_PAGES = 40; // 1,000 calls per day per run

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
  at: string;
}

export async function syncCalls(ctx: TenantContext, dates = syncDates(new Date(), ctx.timezone)): Promise<SyncResult | null> {
  const found = await withTenant(ctx, async (tx) => {
    const [integration] = await tx.select().from(integrations).where(and(eq(integrations.kind, "telephony"), eq(integrations.status, "active")));
    const dids = integration ? await tx.select({ n: telephonyDids.number }).from(telephonyDids).where(eq(telephonyDids.integrationId, integration.id)) : [];
    return { integration, dids: dids.map((d) => d.n) };
  });
  const adapter = found.integration ? telephonyAdapter(found.integration.provider) : undefined;
  if (!found.integration || !adapter?.fetchCallReportPage) return null;
  const creds = JSON.parse(decrypt(found.integration.credentialsEnc)) as Record<string, string>;

  let rows = 0;
  let failed = 0;
  for (const date of dates) {
    const all: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await adapter.fetchCallReportPage(creds, { date, page });
      all.push(...r.rows);
      if (r.lastPage) break;
    }
    // Oldest first so number-matching pairs each report with the right call.
    all.sort((a, b) => String(a.StartTime ?? "").localeCompare(String(b.StartTime ?? "")));
    for (const payload of all) {
      rows++;
      try {
        await applyCallEvents(ctx, found.integration, adapter.parseWebhook(payload, { registeredDids: found.dids }));
      } catch (err) {
        failed++; // e.g. an incoming call on a DID not mapped to a process
        log.warn("call sync row failed", { tenant: ctx.tenantSlug, err });
      }
    }
  }
  const result = { rows, failed, at: new Date().toISOString() };
  await redis().set(keys.callsSync(ctx.tenantId), JSON.stringify(result), { ex: 7 * 86_400 }).catch(() => undefined);
  return result;
}

export async function lastSync(tenantId: string): Promise<SyncResult | null> {
  const v = await redis().get<SyncResult | string>(keys.callsSync(tenantId)).catch(() => null);
  if (!v) return null;
  return typeof v === "string" ? (JSON.parse(v) as SyncResult) : v;
}
