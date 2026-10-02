/**
 * Floor (live supervisor view) — today's numbers in the TENANT timezone.
 *
 * Scope: admins see the whole workspace; supervisors/managers/coordinators
 * see their mapped processes (lib/auth/rbac.ts leadScope). Runs on a read
 * replica (withTenantRead). The five statements run IN PARALLEL, each in its
 * own short read transaction (one connection can't run queries concurrently),
 * so the page waits for the slowest one, not the sum. Aggregations are plain SQL over indexed columns;
 * when volume grows these move to the nightly daily_stats rollup (T3.1).
 */
import { sql, type SQL } from "drizzle-orm";
import { withTenantRead } from "@/lib/db/tenant";
import { leadScope } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { keys, redis } from "@/lib/redis/client";

export interface FloorData {
  kpis: {
    leadsToday: number;
    leadsYesterdaySoFar: number;
    attempted: number;
    connected: number;
    conversions: number;
    conversionsYesterday: number;
    medianFirstCallSec: number | null;
    overdueCallbacks: number;
    unassigned: number;
    avgTalkSec: number | null;
  };
  byHour: { hour: number; attempted: number; connected: number }[];
  currentHour: number;
  funnel: { stage: string; count: number }[];
  sources: { source: string; leads: number; connectRate: number; conversions: number; avgFirstCallMin: number | null }[];
  agents: { id: string; name: string; status: string; calls: number; talkMin: number; conversions: number; openLeads: number; maxOpen: number }[];
}

type Row = Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function getFloor(ctx: SessionContext): Promise<FloorData> {
  const tz = ctx.timezone;
  const scope = leadScope(ctx.actor.role);
  const uid = ctx.actor.userId;
  // Process filter for non-admin roles (process-scoped).
  const procFilter = (col: string): SQL =>
    scope === "tenant" ? sql`true` : sql`${sql.raw(col)} in (select process_id from user_processes where user_id = ${uid})`;
  const dayStart = sql`(date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`;

  const one = (q: SQL) => withTenantRead(ctx, async (tx) => ((await tx.execute(q)).rows[0] ?? {}) as Row);
  const many = (q: SQL) => withTenantRead(ctx, async (tx) => (await tx.execute(q)).rows as Row[]);

  const kQ = one(sql`
      select
        extract(hour from now() at time zone ${tz})::int as h,
        (select count(*) from leads l where l.deleted_at is null and l.created_at >= ${dayStart} and ${procFilter("l.process_id")}) as leads_today,
        (select count(*) from leads l where l.deleted_at is null and l.created_at >= ${dayStart} - interval '1 day' and l.created_at < now() - interval '1 day' and ${procFilter("l.process_id")}) as leads_yday,
        (select count(*) from interactions i where i.type = 'call' and i.direction = 'outbound' and i.started_at >= ${dayStart} and ${procFilter("i.process_id")}) as attempted,
        (select count(*) from interactions i where i.type = 'call' and i.status in ('answered','completed') and i.started_at >= ${dayStart} and ${procFilter("i.process_id")}) as connected,
        (select avg(i.duration_sec) from interactions i where i.type = 'call' and i.status in ('answered','completed') and i.started_at >= ${dayStart} and ${procFilter("i.process_id")}) as avg_talk,
        (select count(*) from leads l where l.deleted_at is null and l.converted_at >= ${dayStart} and ${procFilter("l.process_id")}) as conv,
        (select count(*) from leads l where l.deleted_at is null and l.converted_at >= ${dayStart} - interval '1 day' and l.converted_at < now() - interval '1 day' and ${procFilter("l.process_id")}) as conv_yday,
        (select count(*) from callbacks c join leads l on l.id = c.lead_id where l.deleted_at is null and c.status = 'pending' and c.due_at < now() and ${procFilter("l.process_id")}) as overdue,
        (select count(*) from leads l where l.deleted_at is null and l.assigned_to is null and l.status = 'open' and l.is_active and ${procFilter("l.process_id")}) as unassigned,
        (select percentile_cont(0.5) within group (order by extract(epoch from (f.first_call - l.created_at)))
           from leads l
           join lateral (select min(i.started_at) as first_call from interactions i where i.lead_id = l.id and i.type = 'call' and i.direction = 'outbound') f on f.first_call is not null
           where l.deleted_at is null and l.created_at >= ${dayStart} and ${procFilter("l.process_id")}) as median_first
    `);

  const byHourQ = many(sql`
      select extract(hour from i.started_at at time zone ${tz})::int as hour,
             count(*) filter (where i.direction = 'outbound') as attempted,
             count(*) filter (where i.status in ('answered','completed')) as connected
      from interactions i
      where i.type = 'call' and i.started_at >= ${dayStart} and ${procFilter("i.process_id")}
      group by 1 order by 1`);

    // Each stage is a subset of the one before (a won lead was interested,
    // an interested lead was reached), so the funnel never widens.
  const funnelQ = one(sql`
      with f as (
        select l.assigned_to is not null or l.status = 'won' as assigned,
               l.status = 'won' as won,
               l.status = 'won' or l.last_disposition->>'category' in ('positive','converted') as interested,
               -- Any outcome other than no-answer/busy means the person was reached.
               l.last_disposition->>'category' in ('positive','negative','callback','converted','dnc') as reached,
               exists (select 1 from interactions i where i.lead_id = l.id and i.status in ('answered','completed')) as answered
        from leads l where l.deleted_at is null and l.created_at >= ${dayStart} and ${procFilter("l.process_id")})
      select count(*) as leads_in,
             count(*) filter (where assigned) as assigned,
             count(*) filter (where assigned and (answered or reached or interested)) as connected,
             count(*) filter (where assigned and interested) as interested,
             count(*) filter (where won) as converted
      from f`);

  const sourcesQ = many(sql`
      select l.source->>'kind' as source, count(*) as leads,
             count(*) filter (where exists (select 1 from interactions i where i.lead_id = l.id and i.status in ('answered','completed'))) as connected_leads,
             count(*) filter (where l.status = 'won') as conversions,
             avg(extract(epoch from ((select min(i.started_at) from interactions i where i.lead_id = l.id and i.type = 'call' and i.direction = 'outbound') - l.created_at)) / 60) as avg_first_min
      from leads l where l.deleted_at is null and l.created_at >= ${dayStart} and ${procFilter("l.process_id")}
      group by 1 order by 2 desc`);

  const agentsQ = many(sql`
      select u.id, u.name, u.is_available, u.open_leads, u.max_open_leads,
             (select count(*) from interactions i where i.agent_id = u.id and i.type = 'call' and i.started_at >= ${dayStart}) as calls,
             (select coalesce(sum(i.duration_sec), 0) from interactions i where i.agent_id = u.id and i.type = 'call' and i.started_at >= ${dayStart}) as talk_sec,
             (select count(*) from leads l where l.deleted_at is null and l.assigned_to = u.id and l.converted_at >= ${dayStart}) as conversions
      from users u
      where u.role = 'agent' and u.status = 'active'
        and (${scope === "tenant" ? sql`true` : sql`exists (select 1 from user_processes up where up.user_id = u.id and up.process_id in (select process_id from user_processes where user_id = ${uid}))`})
      order by u.name`);

  // Presence from Redis (on_call / wrap_up / available / break), chained onto
  // the agents query so it overlaps the other statements; falls back to DB availability.
  const withPresence = agentsQ.then(async (agents) => {
    try {
      return { agents, presence: agents.length ? await redis().mget<(string | null)[]>(...agents.map((a) => keys.presence(ctx.tenantId, String(a.id)))) : [] };
    } catch {
      return { agents, presence: [] as (string | null)[] };
    }
  });
  const [k0, byHour, funnel, sources, { agents, presence }] = await Promise.all([kQ, byHourQ, funnelQ, sourcesQ, withPresence]);
  const data = { k: k0, byHour, hourNow: k0, funnel, sources, agents };

  const k = data.k;
  const hourMap = new Map(data.byHour.map((h) => [n(h.hour), h]));
  return {
    kpis: {
      leadsToday: n(k.leads_today),
      leadsYesterdaySoFar: n(k.leads_yday),
      attempted: n(k.attempted),
      connected: n(k.connected),
      conversions: n(k.conv),
      conversionsYesterday: n(k.conv_yday),
      medianFirstCallSec: k.median_first === null || k.median_first === undefined ? null : Math.round(n(k.median_first)),
      overdueCallbacks: n(k.overdue),
      unassigned: n(k.unassigned),
      avgTalkSec: k.avg_talk === null || k.avg_talk === undefined ? null : Math.round(n(k.avg_talk)),
    },
    byHour: Array.from({ length: 12 }, (_, i) => i + 9).map((hour) => ({
      hour,
      attempted: n(hourMap.get(hour)?.attempted),
      connected: n(hourMap.get(hour)?.connected),
    })),
    currentHour: n(data.hourNow.h),
    funnel: [
      { stage: "Leads in", count: n(data.funnel.leads_in) },
      { stage: "Assigned", count: n(data.funnel.assigned) },
      { stage: "Connected", count: n(data.funnel.connected) },
      { stage: "Interested", count: n(data.funnel.interested) },
      { stage: "Converted", count: n(data.funnel.converted) },
    ],
    sources: data.sources.map((s) => ({
      source: String(s.source),
      leads: n(s.leads),
      connectRate: n(s.leads) ? n(s.connected_leads) / n(s.leads) : 0,
      conversions: n(s.conversions),
      avgFirstCallMin: s.avg_first_min === null ? null : Math.round(n(s.avg_first_min) * 10) / 10,
    })),
    agents: data.agents.map((a, i) => ({
      id: String(a.id),
      name: String(a.name),
      status: presence[i] ?? (a.is_available ? "available" : "offline"),
      calls: n(a.calls),
      talkMin: Math.round(n(a.talk_sec) / 60),
      conversions: n(a.conversions),
      openLeads: n(a.open_leads),
      maxOpen: n(a.max_open_leads),
    })),
  };
}
