/**
 * Attendance (T2.20–T2.25) — Jibble clock-ins joined with CRM calls.
 *
 *   ?tab=today   presence, first in, worked, breaks, calls, alerts (refreshes every 60 s)
 *   ?tab=days    day sheet for a period (reuses Reports' periods): first in, last out,
 *                worked, breaks, dialled, connected, talk → talk-time %, calls / worked hour
 *   ?tab=leave   on leave today, upcoming, pending requests, holidays
 *
 * Who appears: attendanceScope (workspace / mapped processes / self). Opening
 * the page polls Jibble in the background when the last poll is > 5 min old
 * (after(); crons are daily on Vercel Hobby). Unknown tab → 404.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/guard";
import { attendanceScope } from "@/lib/auth/rbac";
import { Topbar } from "@/components/shell/topbar";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { attendanceDays, attendanceToday, leaveView } from "@/lib/attendance/view";
import { syncAttendanceIfStale } from "@/lib/platform-admin/attendance";
import { MISMATCH_LABEL, type Presence } from "@/lib/attendance/day";
import { duration, localToday, PERIOD_LABEL, PERIODS, resolveRange, timeIn } from "@/lib/reports/period";
import { log } from "@/lib/log";

export const metadata: Metadata = { title: "Attendance" };
export const dynamic = "force-dynamic";

const TABS = { today: "Today", days: "Day sheet", leave: "Leave & holidays" } as const;
type Tab = keyof typeof TABS;
const PRESENCE: Record<Presence, { label: string; dot: string }> = {
  in: { label: "Clocked in", dot: "bg-teal" },
  break: { label: "On break", dot: "bg-amber" },
  out: { label: "Not clocked in", dot: "bg-ink-4" },
  unknown: { label: "Unknown", dot: "bg-rule-strong" },
};
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ tab?: string; period?: string; from?: string; to?: string }> }) {
  const ctx = await requirePage("attendance");
  const sp = await searchParams;
  const tab = (sp.tab ?? "today") as Tab;
  if (!(tab in TABS)) notFound();
  after(() => syncAttendanceIfStale().catch((err) => log.warn("attendance poll on page view failed", { err })));
  const scope = attendanceScope(ctx.actor.role);
  const who = scope === "own" ? "you" : scope === "tenant" ? "everyone in this workspace" : "your processes";

  return (
    <div className="flex min-h-dvh flex-col">
      {tab === "today" && <AutoRefresh seconds={60} />}
      <Topbar title="Attendance" subtitle={`From Jibble · ${who} · ${ctx.timezone}`} />
      <div className="flex flex-col gap-5 px-4 py-5 sm:px-6">
        <nav className="flex gap-1 overflow-x-auto border-b border-rule" aria-label="Attendance">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <Link key={t} href={`/attendance?tab=${t}`} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium ${t === tab ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}>
              {TABS[t]}
            </Link>
          ))}
        </nav>
        {tab === "today" && <Today data={await attendanceToday(ctx)} tz={ctx.timezone} />}
        {tab === "days" && <Days sp={sp} tz={ctx.timezone} rows={await attendanceDays(ctx, resolveRange(sp, localToday(ctx.timezone)))} range={resolveRange(sp, localToday(ctx.timezone))} />}
        {tab === "leave" && <Leave data={await leaveView(ctx)} />}
      </div>
    </div>
  );
}

function NotConnected() {
  return (
    <div className="panel p-6 text-[13px] text-ink-2">
      Jibble isn’t connected yet. A Super Admin connects it in <Link href="/admin?tab=attendance" className="font-medium text-teal-ink hover:underline">Setup → Attendance (Jibble)</Link>.
    </div>
  );
}

function Today({ data, tz }: { data: Awaited<ReturnType<typeof attendanceToday>>; tz: string }) {
  if (!data.connected) return <NotConnected />;
  const r = data.rows;
  const count = (p: Presence) => r.filter((x) => x.presence === p && !x.onLeave).length;
  const alerts = r.filter((x) => x.alerts.length);
  const kpis = [
    { label: "Clocked in", value: count("in") },
    { label: "On break", value: count("break") },
    { label: "Not clocked in", value: count("out") },
    { label: "On leave", value: r.filter((x) => x.onLeave).length },
    { label: "Alerts", value: alerts.length, alert: alerts.length > 0 },
    { label: "Not in Jibble", value: r.filter((x) => !x.linked).length },
  ];
  return (
    <>
      {data.stale && (
        <p className="rounded-md bg-amber/15 px-3 py-2 text-[12.5px] text-ink-2">
          Last Jibble update: {data.syncedAt ? timeIn(data.syncedAt, tz) : "never"} — refreshing in the background; presence shows “Unknown” until it’s fresh.
        </p>
      )}
      <section className="panel grid grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className="relative border-r border-b border-rule px-4 py-3.5">
            {k.alert && <span className="absolute inset-x-0 top-0 h-[3px] bg-ember" />}
            <div className="eyebrow">{k.label}</div>
            <div className={`mt-1.5 font-mono text-[22px] font-semibold leading-none tnum ${k.alert ? "text-ember-ink" : ""}`}>{k.value}</div>
          </div>
        ))}
      </section>
      {alerts.length > 0 && (
        <section className="panel border-l-[3px] border-l-ember p-4">
          <div className="eyebrow mb-2">Needs a look</div>
          <ul className="flex flex-col gap-1 text-[13px]">
            {alerts.flatMap((x) => x.alerts.map((a) => <li key={`${x.userId}:${a}`}><span className="font-semibold">{x.name}</span> — {MISMATCH_LABEL[a]}</li>))}
          </ul>
        </section>
      )}
      <section className="panel overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left text-ink-3">
              <th className="px-5 py-2 font-medium">Person</th>
              <th className="px-3 py-2 font-medium">Now</th>
              <th className="px-3 py-2 text-right font-medium">Since</th>
              <th className="px-3 py-2 text-right font-medium">First in</th>
              <th className="px-3 py-2 text-right font-medium">Worked</th>
              <th className="px-3 py-2 text-right font-medium">Breaks</th>
              <th className="px-3 py-2 text-right font-medium">Calls</th>
              <th className="px-3 py-2 text-right font-medium">Connected</th>
              <th className="px-3 py-2 text-right font-medium">Talk</th>
              <th className="px-5 py-2 text-right font-medium">Last call</th>
            </tr>
          </thead>
          <tbody>
            {r.map((x) => {
              const p = PRESENCE[x.presence];
              return (
                <tr key={x.userId} className="border-b border-rule last:border-b-0">
                  <td className="px-5 py-2 whitespace-nowrap">
                    <span className="font-medium">{x.name}</span> <span className="text-ink-4">{x.role.replace(/_/g, " ")}</span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {x.onLeave ? (
                      <span className="text-ink-2">On leave</span>
                    ) : !x.linked ? (
                      <span className="text-ink-4">Not in Jibble</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${p.dot}`} />{p.label}</span>
                    )}
                    {x.alerts.length > 0 && <span className="ml-2 rounded bg-ember/10 px-1.5 py-0.5 text-[11px] text-ember-ink">{x.alerts.length} alert</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tnum">{x.presence === "unknown" ? "—" : timeIn(x.since, tz)}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">{timeIn(x.firstIn, tz)}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">{x.workedSec ? duration(x.workedSec) : "—"}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">{x.breakSec ? duration(x.breakSec) : "—"}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">{x.calls}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">{x.connected}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">{x.talkSec ? duration(x.talkSec) : "—"}</td>
                  <td className="px-5 py-2 text-right font-mono tnum">{timeIn(x.lastCall, tz)}</td>
                </tr>
              );
            })}
            {r.length === 0 && <tr><td colSpan={10} className="px-5 py-6 text-[13px] text-ink-3">No one to show.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Days({ rows, range, tz, sp }: { rows: Awaited<ReturnType<typeof attendanceDays>>; range: ReturnType<typeof resolveRange>; tz: string; sp: { period?: string } }) {
  const tot = rows.reduce((a, r) => ({ worked: a.worked + r.workedSec, talk: a.talk + r.talkSec, dialled: a.dialled + r.dialled }), { worked: 0, talk: 0, dialled: 0 });
  return (
    <>
      <form method="get" className="panel flex flex-wrap items-end gap-3 p-3">
        <input type="hidden" name="tab" value="days" />
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
          Period
          <select name="period" defaultValue={sp.period ?? range.period} className="h-9 rounded-md border border-rule bg-sheet px-2 text-[13px] text-ink">
            {PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">From (custom)<input type="date" name="from" defaultValue={range.from} className="h-9 rounded-md border border-rule bg-sheet px-2 text-[13px] text-ink" /></label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">To (custom)<input type="date" name="to" defaultValue={range.to} className="h-9 rounded-md border border-rule bg-sheet px-2 text-[13px] text-ink" /></label>
        <button className="h-9 rounded-md bg-ink px-4 text-[13px] font-semibold text-sheet hover:bg-ink-2">Apply</button>
        <span className="ml-auto text-[12px] text-ink-3">
          Worked {duration(tot.worked)} · talk {duration(tot.talk)} ({pct(tot.worked ? tot.talk / tot.worked : null)}) · {tot.worked ? (tot.dialled / (tot.worked / 3600)).toFixed(1) : "—"} dials / worked hour
        </span>
      </form>
      <section className="panel overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left text-ink-3">
              <th className="px-5 py-2 font-medium">Day</th>
              <th className="px-3 py-2 font-medium">Person</th>
              <th className="px-3 py-2 text-right font-medium">First in</th>
              <th className="px-3 py-2 text-right font-medium">Last out</th>
              <th className="px-3 py-2 text-right font-medium">Worked</th>
              <th className="px-3 py-2 text-right font-medium">Breaks</th>
              <th className="px-3 py-2 text-right font-medium">Dialled</th>
              <th className="px-3 py-2 text-right font-medium">Connected</th>
              <th className="px-3 py-2 text-right font-medium">Talk</th>
              <th className="px-3 py-2 text-right font-medium" title="Talk time ÷ worked time">Talk %</th>
              <th className="px-5 py-2 text-right font-medium">Dials / worked h</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map((r) => (
              <tr key={`${r.userId}:${r.day}`} className="border-b border-rule last:border-b-0">
                <td className="px-5 py-2 whitespace-nowrap">{shortDay(r.day)}</td>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{r.name}{r.onLeave && <span className="ml-2 text-[11px] text-ink-3">on leave</span>}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{timeIn(r.firstIn, tz)}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{timeIn(r.lastOut, tz)}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{r.workedSec ? duration(r.workedSec) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{r.breakSec ? duration(r.breakSec) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{r.dialled}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{r.connected}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{r.talkSec ? duration(r.talkSec) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{pct(r.talkShare)}</td>
                <td className="px-5 py-2 text-right font-mono tnum">{r.callsPerWorkedHour === null ? "—" : r.callsPerWorkedHour.toFixed(1)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={11} className="px-5 py-6 text-[13px] text-ink-3">No clock-ins or calls in this period.</td></tr>}
          </tbody>
        </table>
        <p className="border-t border-rule px-5 py-2.5 text-[11.5px] text-ink-4">
          {rows.length > 500 ? `Showing 500 of ${rows.length} rows. ` : ""}Worked = clocked in minus breaks (Jibble). A past day without a clock-out isn’t counted past the last event.
        </p>
      </section>
    </>
  );
}

function Leave({ data }: { data: Awaited<ReturnType<typeof leaveView>> }) {
  if (!data.connected) return <NotConnected />;
  const list = (rows: typeof data.upcoming, empty: string) =>
    rows.length ? (
      <ul className="flex flex-col divide-y divide-rule text-[13px]">
        {rows.map((l, i) => (
          <li key={i} className="flex items-center justify-between gap-3 py-2">
            <span><span className="font-medium">{l.name}</span>{l.kind && <span className="text-ink-3"> · {l.kind}</span>}</span>
            <span className="font-mono text-[12px] text-ink-2 tnum">{l.startDate === l.endDate ? shortDay(l.startDate) : `${shortDay(l.startDate)} – ${shortDay(l.endDate)}`}</span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-[13px] text-ink-3">{empty}</p>
    );
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <section className="panel p-5"><div className="eyebrow mb-3">On leave today</div>{list(data.onLeaveToday, "Nobody is on leave today.")}<p className="mt-3 text-[11.5px] text-ink-4">New leads aren’t assigned to people on approved leave.</p></section>
      <section className="panel p-5"><div className="eyebrow mb-3">Upcoming (30 days)</div>{list(data.upcoming, "No leave booked.")}</section>
      <section className="panel p-5"><div className="eyebrow mb-3">Waiting for approval</div>{list(data.pending, "No pending requests.")}</section>
      <section className="panel p-5">
        <div className="eyebrow mb-3">Holidays</div>
        {data.holidays.length ? (
          <ul className="flex flex-col divide-y divide-rule text-[13px]">
            {data.holidays.map((h) => <li key={`${h.date}${h.name}`} className="flex justify-between py-2"><span>{h.name}</span><span className="font-mono text-[12px] tnum">{shortDay(h.date)}</span></li>)}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-3">No holidays from Jibble.</p>
        )}
      </section>
    </div>
  );
}
