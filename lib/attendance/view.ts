/**
 * Attendance screen data (T2.20–T2.25): the workspace's members (RLS, read
 * replica) joined with their Jibble attendance (platform tables, looked up
 * only by THOSE members' account ids — lib/platform-admin/attendance.ts).
 *
 *   today   presence (in / break / out / unknown), first in, worked, breaks,
 *           CRM calls today, mismatch alerts, on leave
 *   days    per member per day for a range: first in, last out, worked,
 *           breaks + dialled, connected, talk → talk-time %, calls / worked hour
 *   leave   on leave today, upcoming (30 days), holidays
 *
 * Who appears: attendanceScope (workspace / mapped processes / self).
 */
import { sql } from "drizzle-orm";
import { withTenantRead } from "@/lib/db/tenant";
import { attendanceScope, requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { attendanceFor, holidaysBetween } from "@/lib/platform-admin/attendance";
import { computeDay, mismatches, onLeave, shownPresence, STALE_MS, type Mismatch, type Presence } from "@/lib/attendance/day";
import { daysOf, localToday, type Range } from "@/lib/reports/period";
import { notFound } from "@/lib/http/errors";

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const ms = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date).getTime());
const CONNECTED = sql`('answered','completed')`;
const TAKES_CALLS = new Set(["agent", "process_coordinator"]);

type Member = { id: string; name: string; role: string; accountId: string };

/** Members of this workspace the viewer may see (active, with a login). */
async function members(ctx: SessionContext): Promise<Member[]> {
  const scope = attendanceScope(ctx.actor.role);
  const uid = ctx.actor.userId;
  const cond =
    scope === "tenant"
      ? sql`true`
      : scope === "own"
        ? sql`u.id = ${uid}`
        : scope === "process"
          ? sql`exists (select 1 from user_processes m where m.user_id = u.id and m.process_id in (select up.process_id from user_processes up where up.user_id = ${uid}))`
          : sql`false`;
  const rows = await withTenantRead(ctx, async (tx) =>
    (await tx.execute(sql`select u.id, u.name, u.role, u.account_id from users u where u.status = 'active' and u.account_id is not null and ${cond} order by u.name`)).rows,
  );
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), role: String(r.role), accountId: String(r.account_id) }));
}

/** Calls per member per local day in [from, to]. */
async function callsByDay(ctx: SessionContext, ids: string[], from: string, to: string) {
  if (!ids.length) return [];
  const tz = ctx.timezone;
  return withTenantRead(ctx, async (tx) =>
    (
      await tx.execute(sql`
        select i.agent_id, to_char(i.started_at at time zone ${tz}, 'YYYY-MM-DD') as day,
               count(*) filter (where i.direction = 'outbound') as dialled,
               count(*) filter (where i.status in ${CONNECTED}) as connected,
               coalesce(sum(coalesce(i.talk_sec, i.duration_sec)) filter (where i.status in ${CONNECTED}), 0) as talk_sec,
               max(i.started_at) as last_call
        from interactions i
        where i.type = 'call' and i.agent_id in ${sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`}
          and i.started_at >= ((${from}::date)::timestamp at time zone ${tz}) and i.started_at < ((${to}::date + 1)::timestamp at time zone ${tz})
        group by 1, 2`)
    ).rows.map((r) => ({ userId: String(r.agent_id), day: String(r.day), dialled: n(r.dialled), connected: n(r.connected), talkSec: n(r.talk_sec), lastCall: ms(r.last_call) })),
  );
}

export interface TodayRow {
  userId: string;
  name: string;
  role: string;
  linked: boolean;
  presence: Presence;
  since: number | null;
  firstIn: number | null;
  lastOut: number | null;
  workedSec: number;
  breakSec: number;
  onLeave: boolean;
  calls: number;
  connected: number;
  talkSec: number;
  lastCall: number | null;
  alerts: Mismatch[];
}

export async function attendanceToday(ctx: SessionContext, now = Date.now()) {
  requirePermission(ctx, "attendance", "V");
  const today = localToday(ctx.timezone, new Date(now));
  const ms_ = await members(ctx);
  const [att, calls] = await Promise.all([attendanceFor(ms_.map((m) => m.accountId), today, today), callsByDay(ctx, ms_.map((m) => m.id), today, today)]);
  const personOf = new Map(att.people.map((p) => [p.accountId, p]));
  const rows: TodayRow[] = ms_.map((m) => {
    const p = personOf.get(m.accountId);
    const c = calls.find((x) => x.userId === m.id);
    const day = p ? computeDay(att.entries.filter((e) => e.personId === p.id).map((e) => ({ type: e.type, at: e.at.getTime() })), now) : null;
    const presence: Presence = p ? shownPresence(p.state, att.syncedAt, now) : "unknown";
    const stateAt = p?.stateAt?.getTime() ?? null;
    return {
      userId: m.id,
      name: m.name,
      role: m.role,
      linked: !!p,
      presence,
      since: stateAt,
      firstIn: day?.firstIn ?? null,
      lastOut: day?.lastOut ?? null,
      workedSec: day?.workedSec ?? 0,
      breakSec: day?.breakSec ?? 0,
      onLeave: p ? onLeave(att.leave.filter((l) => l.personId === p.id), today) : false,
      calls: c?.dialled ?? 0,
      connected: c?.connected ?? 0,
      talkSec: c?.talkSec ?? 0,
      lastCall: c?.lastCall ?? null,
      alerts: mismatches({ presence, stateAt, lastCallAt: c?.lastCall ?? null, takesCalls: TAKES_CALLS.has(m.role) }, now),
    };
  });
  return { connected: att.connected, syncedAt: att.syncedAt, stale: att.syncedAt === null || now - att.syncedAt > STALE_MS, today, rows };
}

export interface DayRow {
  userId: string;
  name: string;
  day: string;
  firstIn: number | null;
  lastOut: number | null;
  workedSec: number;
  breakSec: number;
  onLeave: boolean;
  dialled: number;
  connected: number;
  talkSec: number;
  talkShare: number | null; // talk ÷ worked
  callsPerWorkedHour: number | null;
}

export async function attendanceDays(ctx: SessionContext, range: Range, now = Date.now()): Promise<DayRow[]> {
  requirePermission(ctx, "attendance", "V");
  const ms_ = await members(ctx);
  const [att, calls] = await Promise.all([attendanceFor(ms_.map((m) => m.accountId), range.from, range.to), callsByDay(ctx, ms_.map((m) => m.id), range.from, range.to)]);
  const today = localToday(ctx.timezone, new Date(now));
  const personOf = new Map(att.people.map((p) => [p.accountId, p]));
  const out: DayRow[] = [];
  for (const m of ms_) {
    const p = personOf.get(m.accountId);
    for (const d of [...daysOf(range)].reverse()) {
      const ev = p ? att.entries.filter((e) => e.personId === p.id && e.day === d).map((e) => ({ type: e.type, at: e.at.getTime() })) : [];
      const c = calls.find((x) => x.userId === m.id && x.day === d);
      const leave = p ? onLeave(att.leave.filter((l) => l.personId === p.id), d) : false;
      if (!ev.length && !c && !leave) continue;
      const day = computeDay(ev, d === today ? now : undefined);
      out.push({
        userId: m.id,
        name: m.name,
        day: d,
        firstIn: day.firstIn,
        lastOut: day.lastOut,
        workedSec: day.workedSec,
        breakSec: day.breakSec,
        onLeave: leave,
        dialled: c?.dialled ?? 0,
        connected: c?.connected ?? 0,
        talkSec: c?.talkSec ?? 0,
        talkShare: day.workedSec ? (c?.talkSec ?? 0) / day.workedSec : null,
        callsPerWorkedHour: day.workedSec ? (c?.dialled ?? 0) / (day.workedSec / 3600) : null,
      });
    }
  }
  return out;
}

export async function leaveView(ctx: SessionContext, now = Date.now()) {
  requirePermission(ctx, "attendance", "V");
  const today = localToday(ctx.timezone, new Date(now));
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  const ms_ = await members(ctx);
  const [att, holidays] = await Promise.all([attendanceFor(ms_.map((m) => m.accountId), today, until), holidaysBetween(today, `${today.slice(0, 4)}-12-31`)]);
  const nameOf = new Map(att.people.map((p) => [p.id, ms_.find((m) => m.accountId === p.accountId)?.name ?? "—"]));
  const leave = att.leave
    .map((l) => ({ name: nameOf.get(l.personId) ?? "—", startDate: l.startDate, endDate: l.endDate, status: l.status, kind: l.kind }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name));
  return {
    connected: att.connected,
    today,
    onLeaveToday: leave.filter((l) => /^approved$/i.test(l.status) && l.startDate <= today && today <= l.endDate),
    upcoming: leave.filter((l) => l.startDate > today),
    pending: leave.filter((l) => /^pending$/i.test(l.status)),
    holidays: holidays.map((h) => ({ date: h.date, name: h.name })),
  };
}

/** The login behind a member of THIS workspace (RLS) — for linking a Jibble person by hand. */
export async function accountOfMember(ctx: SessionContext, userId: string): Promise<string> {
  const [r] = await withTenantRead(ctx, async (tx) => (await tx.execute(sql`select account_id from users where id = ${userId} and account_id is not null`)).rows);
  if (!r) throw notFound("No such member in this workspace");
  return String(r.account_id);
}

/** Members to pick from when linking (this workspace only). */
export async function memberOptions(ctx: SessionContext) {
  const rows = await withTenantRead(ctx, async (tx) => (await tx.execute(sql`select id, name, email from users where status = 'active' and account_id is not null order by name`)).rows);
  return rows.map((r) => ({ id: String(r.id), label: `${r.name} · ${r.email}` }));
}
