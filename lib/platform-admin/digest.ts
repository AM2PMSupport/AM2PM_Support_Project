/**
 * Manager digest — daily 09:00 email (T1.42, PRD FR-32).
 *
 * Runs inside the tick (every 5 min on Vercel Pro; the daily Hobby tick is at
 * 03:30 UTC = 09:00 IST). A workspace is due between 09:00 and 12:00 in ITS
 * timezone, once a day: a Redis key per workspace and day is set after the
 * round, and each email carries a Resend idempotency key, so retried ticks
 * never double-send. Recipients: active admins, supervisors and managers of
 * the workspace. Each digest is built with that person's own scope (the same
 * Reports queries and lead scope as their screens): admins the workspace,
 * supervisors/managers their mapped processes. No API key → nothing is sent
 * and nothing is marked, so the digest starts as soon as email is configured.
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { callbacks, leads, tenants, users, type Role } from "@/lib/db/schema";
import { platformDb } from "@/lib/platform-admin/db";
import { withTenantRead } from "@/lib/db/tenant";
import { grantsFor } from "@/lib/auth/grants";
import type { SessionContext } from "@/lib/auth/session";
import { leadScopeCondition } from "@/lib/leads/scope";
import { callsReport, overviewReport, reportScope } from "@/lib/reports/reports";
import { localToday } from "@/lib/reports/period";
import { renderDigest, type DigestData } from "@/lib/notifications/digest-render";
import { emailConfigured, sendEmail } from "@/lib/providers/email/resend";
import { publicBaseUrl } from "@/lib/config/env";
import { redis } from "@/lib/redis/client";
import { log } from "@/lib/log";

const ROLES: Role[] = ["admin", "project_supervisor", "manager"];
const FROM_HOUR = 9;
const UNTIL_HOUR = 12;

const hourIn = (tz: string, at: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(at)) % 24;

/** One person's digest numbers, in their scope. */
export async function digestData(ctx: SessionContext, now = new Date()): Promise<DigestData> {
  const scope = await reportScope(ctx, { period: "yesterday" });
  const c = { ctx, ...scope };
  const [o, calls] = await Promise.all([overviewReport(c), callsReport(c)]);
  const tz = ctx.timezone;
  const today = localToday(tz, now);
  const start = sql`((${today}::date)::timestamp at time zone ${tz})`;
  const end = sql`((${today}::date + 1)::timestamp at time zone ${tz})`;
  const open = and(eq(leads.status, "open"), eq(leads.isActive, true), isNull(leads.deletedAt), leadScopeCondition(ctx));
  const { due, unassigned, neverCalled, hot } = await withTenantRead(ctx, async (tx) => {
    const [d] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(callbacks)
      .innerJoin(leads, eq(leads.id, callbacks.leadId))
      .where(and(eq(callbacks.status, "pending"), gte(callbacks.dueAt, start), lt(callbacks.dueAt, end), open));
    const [u] = await tx.select({ n: sql<number>`count(*)::int` }).from(leads).where(and(open, isNull(leads.assignedTo)));
    const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(leads).where(and(open, eq(leads.attempts, 0)));
    const hot = await tx
      .select({ name: sql<string>`coalesce((select c.name from contacts c where c.id = ${leads.contactId}), 'Unknown')`, owner: users.name, stage: leads.stage, next: leads.nextCallbackAt })
      .from(leads)
      .leftJoin(users, eq(users.id, leads.assignedTo))
      .where(and(open, sql`${leads.lastDisposition}->>'category' = 'positive'`))
      .orderBy(desc(leads.lastInteractionAt))
      .limit(8);
    return { due: d?.n ?? 0, unassigned: u?.n ?? 0, neverCalled: n?.n ?? 0, hot };
  });
  const k = o.kpis;
  return {
    workspace: ctx.tenantName,
    recipient: ctx.actor.name.split(" ")[0] ?? ctx.actor.name,
    day: scope.range.from,
    scope: ctx.actor.role === "admin" ? "whole workspace" : "your processes",
    yesterday: { leadsIn: k.leadsIn, reached: k.reached, won: k.won, lost: k.lost, dialled: calls.kpis.dialled, connected: calls.kpis.connected, callbacksDue: calls.callbacks.due, callbacksOnTime: calls.callbacks.onTime },
    today: { callbacksDue: due, overdue: calls.callbacks.overdueNow, unassigned, neverCalled },
    outcomes: calls.outcomes.slice(0, 6).map((x) => ({ label: x.label, count: x.count })),
    hotLeads: hot.map((h) => ({
      name: h.name,
      owner: h.owner,
      stage: h.stage,
      nextCallback: h.next ? new Date(h.next).toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null,
    })),
    url: publicBaseUrl(),
  };
}

/** Tick part: send due digests until `deadline`. Returns a short summary for the tick log. */
export async function runDigests(deadline: number, now = new Date()): Promise<string> {
  if (!emailConfigured()) return "email not configured";
  const db = platformDb();
  const ws = await db.select({ id: tenants.id, slug: tenants.slug, name: tenants.name, timezone: tenants.timezone }).from(tenants).where(inArray(tenants.status, ["active", "trial"]));
  let sent = 0;
  let failed = 0;
  for (const w of ws) {
    if (Date.now() > deadline) break;
    const h = hourIn(w.timezone, now);
    if (h < FROM_HOUR || h >= UNTIL_HOUR) continue;
    const day = localToday(w.timezone, now);
    const key = `t:${w.id}:digest:${day}`;
    if (await redis().get(key).catch(() => null)) continue;
    const people = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, accountId: users.accountId })
      .from(users)
      .where(and(eq(users.tenantId, w.id), eq(users.status, "active"), inArray(users.role, ROLES)));
    let okHere = 0;
    let failHere = 0;
    for (const p of people) {
      if (Date.now() > deadline) break;
      try {
        const base = { tenantId: w.id, tenantSlug: w.slug, timezone: w.timezone };
        const ctx: SessionContext = { ...base, tenantName: w.name, accountId: p.accountId ?? "", actor: { userId: p.id, role: p.role, name: p.name, grants: await grantsFor(base, p.role) } };
        const mail = renderDigest(await digestData(ctx, now));
        const r = await sendEmail({ to: p.email, ...mail, idempotencyKey: `digest:${w.id}:${p.id}:${day}` });
        if (r.ok) okHere++;
        else {
          failHere++;
          log.warn("digest not sent", { tenant: w.slug, code: r.code, message: r.message });
          if (r.code === "rejected" && /api key|unauthor|forbidden|domain/i.test(r.message)) return `stopped: ${r.message}`; // same for everyone — retry next tick
        }
      } catch (err) {
        failHere++; // e.g. reports permission removed for this role
        log.warn("digest skipped for a recipient", { tenant: w.slug, err });
      }
    }
    sent += okHere;
    failed += failHere;
    // Done for today unless every send failed (then the next tick retries; idempotency keys stop doubles).
    if (okHere || !failHere) await redis().set(key, "1", { ex: 2 * 86_400 }).catch(() => undefined);
  }
  return `${sent} sent${failed ? `, ${failed} failed` : ""}`;
}
