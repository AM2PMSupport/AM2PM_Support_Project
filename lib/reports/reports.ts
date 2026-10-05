/**
 * Reports module (T3.2, DESIGN.md §9 Reports) — live queries for a date range.
 *
 *   overview  funnel, KPIs, daily trend, stage mix, why leads were lost
 *   agents    per agent per day: login/logout, first/last call, dialled vs
 *             connected, per-hour rates, talk time, outcomes, conversions,
 *             callback compliance (summed per agent in lib/reports/period.ts)
 *   sources   per lead source: volume, reach, interest, conversion, speed
 *   calls     volume by hour / weekday / day, call results, outcomes, callbacks
 *
 * Range = tenant-local days (lib/reports/period.ts), turned into UTC bounds
 * with `at time zone` so the (tenant_id, <time>) indexes are used (RULE §8).
 * Scope: admins/auditors the workspace, supervisors/managers/coordinators
 * (and roles given lead rights) their mapped processes, agents their own
 * leads and calls (lib/auth/rbac.ts leadScope). Optional process filter.
 * Reads on a replica (withTenantRead); each statement in its own short read
 * transaction, run in parallel. Callback "on time" = an outbound call to the
 * lead from 5 min before to 15 min after it was due (PRD §8 compliance).
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { withTenantRead } from "@/lib/db/tenant";
import { leadScope, requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { daysOf, localToday, resolveRange, type AgentDay, type Range } from "@/lib/reports/period";
import { myProcesses } from "@/lib/agent/queue";
import { notFound } from "@/lib/http/errors";

export const REPORT_TABS = ["overview", "agents", "sources", "calls"] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

/**
 * URL params → range + process filter. A process that isn't one of the
 * person's own (or isn't a uuid) is a 404, like any record outside their
 * access (SECURITY.md §3.3).
 */
export async function reportScope(ctx: SessionContext, params: { period?: string; from?: string; to?: string; process?: string }) {
  const range = resolveRange(params, localToday(ctx.timezone));
  const processes = await myProcesses(ctx);
  const processId = params.process || undefined;
  if (processId && (!z.uuid().safeParse(processId).success || !processes.some((p) => p.id === processId))) throw notFound("Process not found");
  return { range, processId, processes };
}

type Row = Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const nOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const ms = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date).getTime());
const CONNECTED = sql`('answered','completed')`;
const LIVE = sql`('initiated','agent_ringing','customer_ringing','ringing')`;

interface Ctx {
  ctx: SessionContext;
  range: Range;
  processId?: string;
}

/** Bounds, scope conditions (fixed aliases: l = leads, i = interactions, u = users) and the query runners. */
function parts({ ctx, range, processId }: Ctx) {
  const tz = ctx.timezone;
  const scope = leadScope(ctx.actor.role);
  const uid = ctx.actor.userId;
  const mine = sql`(select up.process_id from user_processes up where up.user_id = ${uid})`;
  const proc = (col: SQL) => (processId ? sql` and ${col} = ${processId}` : sql``);
  const F = sql`((${range.from}::date)::timestamp at time zone ${tz})`;
  const T = sql`((${range.to}::date + 1)::timestamp at time zone ${tz})`;
  const leadCond = sql`(${scope === "tenant" ? sql`true` : scope === "own" ? sql`l.assigned_to = ${uid}` : scope === "process" ? sql`l.process_id in ${mine}` : sql`false`}${proc(sql`l.process_id`)})`;
  const callCond = sql`(${scope === "tenant" ? sql`true` : scope === "own" ? sql`i.agent_id = ${uid}` : scope === "process" ? sql`i.process_id in ${mine}` : sql`false`}${proc(sql`i.process_id`)})`;
  const userCond = sql`(${
    scope === "tenant" ? sql`true` : scope === "own" ? sql`u.id = ${uid}` : scope === "process" ? sql`exists (select 1 from user_processes m where m.user_id = u.id and m.process_id in ${mine})` : sql`false`
  }${processId ? sql` and exists (select 1 from user_processes m2 where m2.user_id = u.id and m2.process_id = ${processId})` : sql``})`;
  const day = (col: SQL) => sql`to_char(${col} at time zone ${tz}, 'YYYY-MM-DD')`;
  const one = (q: SQL) => withTenantRead(ctx, async (tx) => ((await tx.execute(q)).rows[0] ?? {}) as Row);
  const many = (q: SQL) => withTenantRead(ctx, async (tx) => (await tx.execute(q)).rows as Row[]);
  // Leads created in the range, with what happened to each (shared by overview + sources).
  const leadFacts = sql`
    select l.id, l.status, l.stage, l.created_at, l.converted_at, l.assigned_to,
           coalesce(l.source->>'kind', 'unknown') as source,
           l.last_disposition->>'category' as cat,
           l.last_disposition->>'label' as last_label,
           exists (select 1 from interactions i where i.lead_id = l.id and i.type = 'call' and i.status in ${CONNECTED}) as answered,
           (select min(i.started_at) from interactions i where i.lead_id = l.id and i.type = 'call' and i.direction = 'outbound') as first_call
    from leads l
    where l.deleted_at is null and l.created_at >= ${F} and l.created_at < ${T} and ${leadCond}`;
  return { tz, F, T, leadCond, callCond, userCond, day, one, many, leadFacts };
}

/** Reached = answered a call, or got an outcome that needs a conversation. */
const REACHED = sql`(answered or cat in ('positive','negative','callback','converted','dnc'))`;
const INTERESTED = sql`(status = 'won' or cat in ('positive','converted'))`;

export async function overviewReport(c: Ctx) {
  requirePermission(c.ctx, "reports", "V");
  const p = parts(c);
  const [k, stages, trend, lost] = await Promise.all([
    p.one(sql`
      with f as (${p.leadFacts})
      select count(*) as leads_in,
             count(*) filter (where assigned_to is not null or status = 'won') as assigned,
             count(*) filter (where first_call is not null) as attempted,
             count(*) filter (where ${REACHED}) as reached,
             count(*) filter (where ${INTERESTED}) as interested,
             count(*) filter (where status = 'won') as won,
             count(*) filter (where status in ('lost','dnc')) as lost,
             count(*) filter (where status = 'open') as open,
             count(*) filter (where status = 'open' and first_call is null) as never_called,
             percentile_cont(0.5) within group (order by extract(epoch from first_call - created_at)) filter (where first_call is not null) as median_first_sec,
             percentile_cont(0.5) within group (order by extract(epoch from converted_at - created_at)) filter (where converted_at is not null) as median_convert_sec
      from f`),
    p.many(sql`select l.stage, count(*) as n from leads l where l.deleted_at is null and l.created_at >= ${p.F} and l.created_at < ${p.T} and ${p.leadCond} group by 1 order by 2 desc limit 20`),
    p.many(sql`
      select d, sum(lead_in) as leads_in, sum(won) as won from (
        select ${p.day(sql`l.created_at`)} as d, 1 as lead_in, 0 as won from leads l
          where l.deleted_at is null and l.created_at >= ${p.F} and l.created_at < ${p.T} and ${p.leadCond}
        union all
        select ${p.day(sql`l.converted_at`)}, 0, 1 from leads l
          where l.deleted_at is null and l.converted_at >= ${p.F} and l.converted_at < ${p.T} and ${p.leadCond}
      ) x group by d`),
    p.many(sql`with f as (${p.leadFacts}) select coalesce(last_label, 'No outcome recorded') as reason, count(*) as n from f where status in ('lost','dnc') group by 1 order by 2 desc limit 10`),
  ]);
  const byDay = new Map(trend.map((t) => [String(t.d), t]));
  return {
    kpis: {
      leadsIn: n(k.leads_in),
      attempted: n(k.attempted),
      reached: n(k.reached),
      interested: n(k.interested),
      won: n(k.won),
      lost: n(k.lost),
      open: n(k.open),
      neverCalled: n(k.never_called),
      medianFirstCallSec: nOrNull(k.median_first_sec),
      medianConvertSec: nOrNull(k.median_convert_sec),
    },
    // Each stage is a subset of the one before, so the funnel never widens.
    funnel: [
      { stage: "Leads in", count: n(k.leads_in) },
      { stage: "Assigned", count: n(k.assigned) },
      { stage: "Called", count: n(k.attempted) },
      { stage: "Reached", count: n(k.reached) },
      { stage: "Interested", count: n(k.interested) },
      { stage: "Won", count: n(k.won) },
    ],
    stages: stages.map((s) => ({ stage: String(s.stage), count: n(s.n) })),
    trend: daysOf(c.range).map((d) => ({ day: d, leadsIn: n(byDay.get(d)?.leads_in), won: n(byDay.get(d)?.won) })),
    lostReasons: lost.map((r) => ({ reason: String(r.reason), count: n(r.n) })),
  };
}

export async function sourcesReport(c: Ctx) {
  requirePermission(c.ctx, "reports", "V");
  const p = parts(c);
  const rows = await p.many(sql`
    with f as (${p.leadFacts})
    select source, count(*) as leads,
           count(*) filter (where first_call is not null) as attempted,
           count(*) filter (where ${REACHED}) as reached,
           count(*) filter (where ${INTERESTED}) as interested,
           count(*) filter (where status = 'won') as won,
           count(*) filter (where status in ('lost','dnc')) as lost,
           count(*) filter (where status = 'open' and first_call is null) as never_called,
           percentile_cont(0.5) within group (order by extract(epoch from first_call - created_at)) filter (where first_call is not null) as median_first_sec
    from f group by 1 order by 2 desc`);
  return rows.map((r) => ({
    source: String(r.source),
    leads: n(r.leads),
    attempted: n(r.attempted),
    reached: n(r.reached),
    interested: n(r.interested),
    won: n(r.won),
    lost: n(r.lost),
    neverCalled: n(r.never_called),
    medianFirstCallSec: nOrNull(r.median_first_sec),
  }));
}

export async function callsReport(c: Ctx) {
  requirePermission(c.ctx, "reports", "V");
  const p = parts(c);
  const inRange = sql`i.type = 'call' and i.started_at >= ${p.F} and i.started_at < ${p.T} and ${p.callCond}`;
  const onTime = sql`exists (select 1 from interactions i where i.lead_id = cb.lead_id and i.type = 'call' and i.direction = 'outbound' and i.started_at between cb.due_at - interval '5 minutes' and cb.due_at + interval '15 minutes')`;
  const calledAfter = sql`exists (select 1 from interactions i where i.lead_id = cb.lead_id and i.type = 'call' and i.direction = 'outbound' and i.started_at >= cb.due_at - interval '5 minutes')`;
  const [k, byHour, byWeekday, byDay, results, outcomes, cb] = await Promise.all([
    p.one(sql`
      select count(*) filter (where i.direction = 'outbound') as dialled,
             count(*) filter (where i.direction = 'outbound' and i.status in ${CONNECTED}) as connected,
             count(*) filter (where i.direction = 'inbound') as inbound,
             count(*) filter (where i.direction = 'inbound' and i.status in ${CONNECTED}) as inbound_answered,
             count(*) filter (where i.direction = 'inbound' and i.status not in ${CONNECTED} and i.status not in ${LIVE}) as inbound_missed,
             coalesce(sum(coalesce(i.talk_sec, i.duration_sec)) filter (where i.status in ${CONNECTED}), 0) as talk_sec,
             count(*) filter (where i.status in ${CONNECTED}) as talked,
             count(distinct i.lead_id) as leads_called,
             count(distinct i.agent_id) as agents
      from interactions i where ${inRange}`),
    p.many(sql`
      select extract(hour from i.started_at at time zone ${p.tz})::int as h,
             count(*) filter (where i.direction = 'outbound') as dialled,
             count(*) filter (where i.status in ${CONNECTED}) as connected
      from interactions i where ${inRange} group by 1`),
    p.many(sql`
      select extract(isodow from i.started_at at time zone ${p.tz})::int as dow,
             count(*) filter (where i.direction = 'outbound') as dialled,
             count(*) filter (where i.status in ${CONNECTED}) as connected
      from interactions i where ${inRange} group by 1`),
    p.many(sql`
      select ${p.day(sql`i.started_at`)} as d,
             count(*) filter (where i.direction = 'outbound') as dialled,
             count(*) filter (where i.direction = 'outbound' and i.status in ${CONNECTED}) as connected,
             count(*) filter (where i.direction = 'inbound') as inbound,
             coalesce(sum(coalesce(i.talk_sec, i.duration_sec)) filter (where i.status in ${CONNECTED}), 0) as talk_sec
      from interactions i where ${inRange} group by 1`),
    p.many(sql`select i.direction, i.status, count(*) as n from interactions i where ${inRange} and i.status not in ${LIVE} group by 1, 2 order by 3 desc`),
    p.many(sql`
      select i.disposition->>'label' as label, i.disposition->>'category' as cat, count(*) as n
      from interactions i where ${inRange} and i.disposition is not null group by 1, 2 order by 3 desc limit 15`),
    p.one(sql`
      select count(*) as due,
             count(*) filter (where on_time) as on_time,
             count(*) filter (where not on_time and called) as late,
             count(*) filter (where not called) as not_called,
             (select count(*) from callbacks cb join leads l on l.id = cb.lead_id
                where cb.status = 'pending' and cb.due_at < now() and l.deleted_at is null and ${p.leadCond}) as overdue_now
      from (select ${onTime} as on_time, ${calledAfter} as called
            from callbacks cb join leads l on l.id = cb.lead_id
            where cb.status <> 'cancelled' and cb.due_at >= ${p.F} and cb.due_at < least(${p.T}, now()) and l.deleted_at is null and ${p.leadCond}) x`),
  ]);
  const hours = new Map(byHour.map((h) => [n(h.h), h]));
  const dows = new Map(byWeekday.map((d) => [n(d.dow), d]));
  const days = new Map(byDay.map((d) => [String(d.d), d]));
  return {
    kpis: {
      dialled: n(k.dialled),
      connected: n(k.connected),
      inbound: n(k.inbound),
      inboundAnswered: n(k.inbound_answered),
      inboundMissed: n(k.inbound_missed),
      talkSec: n(k.talk_sec),
      avgTalkSec: n(k.talked) ? Math.round(n(k.talk_sec) / n(k.talked)) : null,
      leadsCalled: n(k.leads_called),
      agents: n(k.agents),
    },
    byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, attempted: n(hours.get(h)?.dialled), connected: n(hours.get(h)?.connected) })),
    byWeekday: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dow: d, dialled: n(dows.get(d)?.dialled), connected: n(dows.get(d)?.connected) })),
    byDay: daysOf(c.range).map((d) => ({ day: d, dialled: n(days.get(d)?.dialled), connected: n(days.get(d)?.connected), inbound: n(days.get(d)?.inbound), talkSec: n(days.get(d)?.talk_sec) })),
    results: results.map((r) => ({ direction: String(r.direction), status: String(r.status), count: n(r.n) })),
    outcomes: outcomes.map((o) => ({ label: String(o.label ?? "—"), category: String(o.cat ?? ""), count: n(o.n) })),
    callbacks: { due: n(cb.due), onTime: n(cb.on_time), late: n(cb.late), notCalled: n(cb.not_called), overdueNow: n(cb.overdue_now) },
  };
}

/**
 * One row per agent per working day. Login / logout come from the audit log
 * (`auth.login`, `auth.logout`, recorded since 2026-10-05); a day without an
 * explicit sign-out shows the last call as the last activity instead.
 */
export async function agentDays(c: Ctx): Promise<AgentDay[]> {
  requirePermission(c.ctx, "reports", "V");
  const p = parts(c);
  const onTime = sql`exists (select 1 from interactions i where i.lead_id = cb.lead_id and i.type = 'call' and i.direction = 'outbound' and i.started_at between cb.due_at - interval '5 minutes' and cb.due_at + interval '15 minutes')`;
  const rows = await p.many(sql`
    with c as (
      select i.agent_id, ${p.day(sql`i.started_at`)} as day,
             count(*) filter (where i.direction = 'outbound') as dialled,
             count(*) filter (where i.direction = 'outbound' and i.status in ${CONNECTED}) as connected,
             count(*) filter (where i.direction = 'inbound' and i.status in ${CONNECTED}) as inbound_answered,
             count(*) filter (where i.direction = 'inbound' and i.status not in ${CONNECTED} and i.status not in ${LIVE}) as inbound_missed,
             coalesce(sum(coalesce(i.talk_sec, i.duration_sec)) filter (where i.status in ${CONNECTED}), 0) as talk_sec,
             min(i.started_at) as first_call,
             max(coalesce(i.ended_at, i.started_at)) as last_call,
             count(*) filter (where i.disposition->>'category' = 'positive') as interested,
             count(*) filter (where i.disposition->>'category' = 'callback') as callbacks_set,
             count(*) filter (where i.disposition->>'category' = 'negative') as not_interested
      from interactions i
      where i.type = 'call' and i.agent_id is not null and i.started_at >= ${p.F} and i.started_at < ${p.T} and ${p.callCond}
      group by 1, 2),
    w as (
      select l.assigned_to as agent_id, ${p.day(sql`l.converted_at`)} as day, count(*) as won
      from leads l
      where l.deleted_at is null and l.assigned_to is not null and l.converted_at >= ${p.F} and l.converted_at < ${p.T} and ${p.leadCond}
      group by 1, 2),
    cb as (
      select cb.assigned_to as agent_id, ${p.day(sql`cb.due_at`)} as day, count(*) as due, count(*) filter (where ${onTime}) as on_time
      from callbacks cb join leads l on l.id = cb.lead_id
      where cb.assigned_to is not null and cb.status <> 'cancelled' and cb.due_at >= ${p.F} and cb.due_at < least(${p.T}, now()) and l.deleted_at is null and ${p.leadCond}
      group by 1, 2),
    s as (
      select a.actor_id as agent_id, ${p.day(sql`a.created_at`)} as day,
             min(a.created_at) filter (where a.action = 'auth.login') as login,
             max(a.created_at) filter (where a.action = 'auth.logout') as logout
      from audit_logs a
      where a.action in ('auth.login','auth.logout') and a.actor_id is not null and a.created_at >= ${p.F} and a.created_at < ${p.T}
      group by 1, 2),
    k as (
      select agent_id, day from c
      union select agent_id, day from w
      union select agent_id, day from cb
      union select s.agent_id, s.day from s join users su on su.id = s.agent_id where su.role in ('agent','process_coordinator'))
    select u.id, u.name, k.day, s.login, s.logout, c.first_call, c.last_call,
           extract(epoch from (c.first_call at time zone ${p.tz})::time) / 60 as first_min,
           extract(epoch from (c.last_call at time zone ${p.tz})::time) / 60 as last_min,
           c.dialled, c.connected, c.inbound_answered, c.inbound_missed, c.talk_sec, c.interested, c.callbacks_set, c.not_interested,
           w.won, cb.due, cb.on_time
    from k
    join users u on u.id = k.agent_id
    left join c on c.agent_id = k.agent_id and c.day = k.day
    left join w on w.agent_id = k.agent_id and w.day = k.day
    left join cb on cb.agent_id = k.agent_id and cb.day = k.day
    left join s on s.agent_id = k.agent_id and s.day = k.day
    where ${p.userCond}
    order by u.name, k.day desc`);
  return rows.map((r) => ({
    agentId: String(r.id),
    name: String(r.name),
    day: String(r.day),
    login: ms(r.login),
    logout: ms(r.logout),
    firstCall: ms(r.first_call),
    lastCall: ms(r.last_call),
    firstCallMin: nOrNull(r.first_min),
    lastCallMin: nOrNull(r.last_min),
    dialled: n(r.dialled),
    connected: n(r.connected),
    inboundAnswered: n(r.inbound_answered),
    inboundMissed: n(r.inbound_missed),
    talkSec: n(r.talk_sec),
    interested: n(r.interested),
    callbacksSet: n(r.callbacks_set),
    notInterested: n(r.not_interested),
    won: n(r.won),
    callbacksDue: n(r.due),
    callbacksOnTime: n(r.on_time),
  }));
}
