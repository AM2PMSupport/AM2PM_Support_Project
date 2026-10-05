/**
 * Reports (T3.2, DESIGN.md §9) — any date range, on live data (read replica).
 *
 *   ?tab=overview|agents|sources|calls  &period=today|yesterday|7d|30d|this_month|last_month|custom
 *   &from=yyyy-mm-dd&to=yyyy-mm-dd (custom)  &process=<id>
 *
 * Filters are a plain GET form and tabs are links, so the page works with no
 * client JS and every view is a shareable URL. Only the open tab's data is
 * loaded. Scope (whole workspace / mapped processes / own numbers) comes from
 * lib/reports/reports.ts; an unknown tab or process is a 404. CSV links go to
 * /api/v1/reports/export (needs Reports · X).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import type { ReactNode } from "react";
import { requirePage } from "@/lib/auth/guard";
import { can, leadScope } from "@/lib/auth/rbac";
import { Topbar } from "@/components/shell/topbar";
import { SectionTitle } from "@/components/ui/primitives";
import { CallsByHour, Funnel } from "@/components/dashboard/charts";
import { SOURCE_LABEL } from "@/lib/ui/status";
import { agentDays, callsReport, overviewReport, REPORT_TABS, reportScope, sourcesReport, type ReportTab } from "@/lib/reports/reports";
import { activeSecOf, clockOf, duration, PERIOD_LABEL, PERIODS, perHour, summariseAgents, timeIn, type Range } from "@/lib/reports/period";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

const TAB_LABEL: Record<ReportTab, string> = { overview: "Overview", agents: "Agents", sources: "Sources", calls: "Calls & callbacks" };
const RESULT_LABEL: Record<string, string> = {
  completed: "Connected", answered: "Connected", no_answer: "Customer didn't answer", agent_no_answer: "Agent didn't pick up", busy: "Busy",
  failed: "Failed", missed: "Missed", unknown: "No result from provider",
};
const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_SHEET_ROWS = 300;

const pctText = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
const rate = (v: number | null) => (v === null ? "—" : (Math.round(v * 10) / 10).toFixed(1));
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });

type Search = { tab?: string; period?: string; from?: string; to?: string; process?: string };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requirePage("reports");
  const sp = await searchParams;
  const tab = (sp.tab ?? "overview") as ReportTab;
  if (!REPORT_TABS.includes(tab)) notFound();
  const scope = await reportScope(ctx, sp).catch((err: { status?: number }) => (err?.status === 404 ? notFound() : Promise.reject(err)));
  const c = { ctx, ...scope };
  const { range, processId, processes } = scope;
  const own = leadScope(ctx.actor.role) === "own";
  const canExport = can(ctx.actor, "reports", "X");

  // Query string for links: same filters, other tab / export.
  const qs = (extra: Record<string, string>) =>
    new URLSearchParams({ period: range.period, ...(range.period === "custom" ? { from: range.from, to: range.to } : {}), ...(processId ? { process: processId } : {}), ...extra }).toString();
  const exportLink = (report: string) =>
    canExport ? (
      <a href={`/api/v1/reports/export?${qs({ report })}`} className="inline-flex items-center gap-1 text-[12px] font-medium text-teal-ink hover:underline">
        <Download size={12} /> CSV
      </a>
    ) : null;

  const scopeText = own ? "your own numbers" : processId ? processes.find((p) => p.id === processId)?.name ?? "" : leadScope(ctx.actor.role) === "tenant" ? "all processes" : "your processes";

  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar title="Reports" subtitle={`${rangeText(range)} · ${scopeText} · ${ctx.timezone}`} />
      <div className="flex flex-col gap-5 px-4 py-5 sm:px-6">
        <form method="get" className="panel flex flex-wrap items-end gap-3 p-3">
          <input type="hidden" name="tab" value={tab} />
          <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
            Period
            <select name="period" defaultValue={range.period} className="h-9 rounded-md border border-rule bg-sheet px-2 text-[13px] text-ink">
              {PERIODS.map((p) => (
                <option key={p} value={p}>{PERIOD_LABEL[p]}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
            From (custom)
            <input type="date" name="from" defaultValue={range.from} max={range.to} className="h-9 rounded-md border border-rule bg-sheet px-2 text-[13px] text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
            To (custom)
            <input type="date" name="to" defaultValue={range.to} className="h-9 rounded-md border border-rule bg-sheet px-2 text-[13px] text-ink" />
          </label>
          {processes.length > 1 && (
            <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
              Process
              <select name="process" defaultValue={processId ?? ""} className="h-9 rounded-md border border-rule bg-sheet px-2 text-[13px] text-ink">
                <option value="">All</option>
                {processes.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}
          <button className="h-9 rounded-md bg-ink px-4 text-[13px] font-semibold text-sheet hover:bg-ink-2">Apply</button>
          <span className="text-[11.5px] text-ink-4">Dates are for “Custom”; up to 92 days.</span>
        </form>

        <nav className="flex gap-1 overflow-x-auto border-b border-rule" aria-label="Report">
          {REPORT_TABS.map((t) => (
            <Link
              key={t}
              href={`/reports?${qs({ tab: t })}`}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium ${t === tab ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}
            >
              {TAB_LABEL[t]}
            </Link>
          ))}
        </nav>

        {tab === "overview" && <Overview data={await overviewReport(c)} exportLink={exportLink} />}
        {tab === "agents" && <Agents days={await agentDays(c)} tz={ctx.timezone} exportLink={exportLink} own={own} />}
        {tab === "sources" && <Sources rows={await sourcesReport(c)} exportLink={exportLink} />}
        {tab === "calls" && <Calls data={await callsReport(c)} exportLink={exportLink} />}
      </div>
    </div>
  );
}

function rangeText(r: Range) {
  if (r.period !== "custom") return PERIOD_LABEL[r.period];
  return r.from === r.to ? shortDay(r.from) : `${shortDay(r.from)} – ${shortDay(r.to)}`;
}

function Kpis({ items }: { items: { label: string; value: string; note?: string; alert?: boolean }[] }) {
  return (
    <section className="panel grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
      {items.map((x) => (
        <div key={x.label} className="relative border-r border-b border-rule px-4 py-3.5">
          {x.alert && <span className="absolute inset-x-0 top-0 h-[3px] bg-ember" />}
          <div className="eyebrow">{x.label}</div>
          <div className={`mt-1.5 font-mono text-[22px] font-semibold leading-none tracking-tight tnum ${x.alert ? "text-ember-ink" : ""}`}>{x.value}</div>
          {x.note && <div className="mt-1 text-[11px] text-ink-4">{x.note}</div>}
        </div>
      ))}
    </section>
  );
}

/** Horizontal bar list (stage mix, lost reasons, outcomes, weekdays). */
function Bars({ rows, empty }: { rows: { label: string; value: number; note?: string }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="py-4 text-[13px] text-ink-3">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[12.5px]">
          <span className="truncate" title={r.label}>{r.label}</span>
          <span className="relative h-2 rounded-full bg-rule">
            <span className="absolute inset-y-0 left-0 rounded-full bg-teal-ink" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="font-mono tnum text-ink-2">
            {r.value}
            {r.note && <span className="ml-1 text-ink-4">{r.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Two series per day as paired columns (leads in vs won, dialled vs connected). */
function DayColumns({ rows, a, b }: { rows: { day: string; a: number; b: number }[]; a: string; b: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.a, r.b)));
  const label = rows.length <= 14 ? 1 : Math.ceil(rows.length / 10);
  return (
    <div>
      <div className="flex h-40 items-end gap-[3px]" role="img" aria-label={`${a} and ${b} per day`}>
        {rows.map((r) => (
          <div key={r.day} className="flex h-full min-w-0 flex-1 items-end gap-[1px]" title={`${shortDay(r.day)}: ${r.a} ${a.toLowerCase()}, ${r.b} ${b.toLowerCase()}`}>
            <span className="flex-1 rounded-t-[2px] border border-ink-3" style={{ height: `${(r.a / max) * 100}%` }} />
            <span className="flex-1 rounded-t-[2px] bg-teal-ink" style={{ height: `${(r.b / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px] text-[10px] text-ink-4">
        {rows.map((r, i) => (
          <span key={r.day} className="min-w-0 flex-1 truncate text-center">{i % label === 0 ? shortDay(r.day) : ""}</span>
        ))}
      </div>
      <div className="mt-2 flex gap-4 text-[11.5px] text-ink-3">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] border border-ink-3" />{a}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-teal-ink" />{b}</span>
      </div>
    </div>
  );
}

function Panel({ eyebrow, title, right, children, flush }: { eyebrow?: string; title: string; right?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`panel ${flush ? "overflow-hidden" : "p-5"}`}>
      <div className={flush ? "p-5 pb-3" : "mb-4"}><SectionTitle eyebrow={eyebrow} title={title} right={right} /></div>
      {children}
    </section>
  );
}

type ExportLink = (report: string) => ReactNode;

function Overview({ data, exportLink }: { data: Awaited<ReturnType<typeof overviewReport>>; exportLink: ExportLink }) {
  const k = data.kpis;
  return (
    <>
      <Kpis
        items={[
          { label: "Leads in", value: String(k.leadsIn) },
          { label: "Called", value: pctText(k.attempted, k.leadsIn), note: `${k.attempted} leads` },
          { label: "Reached", value: pctText(k.reached, k.leadsIn), note: `${k.reached} leads` },
          { label: "Interested", value: String(k.interested), note: pctText(k.interested, k.leadsIn) },
          { label: "Won", value: String(k.won), note: `${pctText(k.won, k.leadsIn)} conversion` },
          { label: "Lost", value: String(k.lost), note: pctText(k.lost, k.leadsIn) },
          { label: "Never called", value: String(k.neverCalled), note: "still open", alert: k.neverCalled > 0 },
          { label: "Median first call", value: duration(k.medianFirstCallSec), note: `to win: ${duration(k.medianConvertSec)}` },
        ]}
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <Panel eyebrow="Leads created in this period" title="Where leads drop out">
          <Funnel data={data.funnel} />
        </Panel>
        <Panel eyebrow="Trend" title="Leads in and won per day" right={exportLink("overview")}>
          <DayColumns rows={data.trend.map((t) => ({ day: t.day, a: t.leadsIn, b: t.won }))} a="Leads in" b="Won" />
        </Panel>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel eyebrow="Now" title="Current stage of these leads">
          <Bars rows={data.stages.map((s) => ({ label: s.stage, value: s.count }))} empty="No leads in this period." />
        </Panel>
        <Panel eyebrow="Lost" title="Why leads were lost (last outcome)">
          <Bars rows={data.lostReasons.map((r) => ({ label: r.reason, value: r.count }))} empty="No lost leads in this period." />
        </Panel>
      </div>
    </>
  );
}

function Agents({ days, tz, exportLink, own }: { days: Awaited<ReturnType<typeof agentDays>>; tz: string; exportLink: ExportLink; own: boolean }) {
  const agents = summariseAgents(days);
  const tot = agents.reduce(
    (a, x) => ({ dialled: a.dialled + x.dialled, connected: a.connected + x.connected, talkSec: a.talkSec + x.talkSec, won: a.won + x.won, due: a.due + x.callbacksDue, onTime: a.onTime + x.callbacksOnTime }),
    { dialled: 0, connected: 0, talkSec: 0, won: 0, due: 0, onTime: 0 },
  );
  const th = "px-3 py-2 text-right font-medium whitespace-nowrap";
  const td = "px-3 py-2 text-right font-mono tnum whitespace-nowrap";
  return (
    <>
      <Kpis
        items={[
          { label: own ? "Days worked" : "Agents", value: String(own ? agents[0]?.daysActive ?? 0 : agents.length) },
          { label: "Dialled", value: String(tot.dialled) },
          { label: "Connected", value: String(tot.connected), note: `${pctText(tot.connected, tot.dialled)} of dials` },
          { label: "Talk time", value: duration(tot.talkSec) },
          { label: "Won", value: String(tot.won), note: `${pctText(tot.won, tot.connected)} of connected` },
          { label: "Callbacks on time", value: pctText(tot.onTime, tot.due), note: `${tot.onTime} of ${tot.due}`, alert: tot.due > 0 && tot.onTime / tot.due < 0.8 },
        ]}
      />
      <Panel flush eyebrow="Per agent, whole period" title="Agent performance" right={exportLink("agents")}>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-y border-rule text-left text-ink-3">
                <th className="sticky left-0 bg-sheet px-5 py-2 font-medium">Agent</th>
                <th className={th}>Days</th>
                <th className={th}>Dialled</th>
                <th className={th}>Connected</th>
                <th className={th}>Connect %</th>
                <th className={th} title="Dialled per working hour (first → last call, at least 1 h a day)">Dialled / h</th>
                <th className={th}>Connected / h</th>
                <th className={th}>Avg first call</th>
                <th className={th}>Avg last call</th>
                <th className={th} title="Inbound answered / missed">Inbound</th>
                <th className={th}>Talk time</th>
                <th className={th}>Avg talk</th>
                <th className={th}>Interested</th>
                <th className={th}>Callbacks set</th>
                <th className={th}>Not interested</th>
                <th className={th}>Won</th>
                <th className={th} title="Won ÷ connected">Conv. %</th>
                <th className={`${th} pr-5`} title="Called from 5 min before to 15 min after due">Callbacks on time</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agentId} className="border-b border-rule last:border-b-0">
                  <td className="sticky left-0 bg-sheet px-5 py-2 font-medium whitespace-nowrap">{a.name}</td>
                  <td className={td}>{a.daysActive}</td>
                  <td className={td}>{a.dialled}</td>
                  <td className={td}>{a.connected}</td>
                  <td className={td}>{a.connectRate === null ? "—" : `${Math.round(a.connectRate * 100)}%`}</td>
                  <td className={td}>{rate(a.dialledPerHour)}</td>
                  <td className={td}>{rate(a.connectedPerHour)}</td>
                  <td className={td}>{clockOf(a.avgFirstCallMin)}</td>
                  <td className={td}>{clockOf(a.avgLastCallMin)}</td>
                  <td className={td}>{a.inboundAnswered} / <span className={a.inboundMissed ? "text-ember-ink" : ""}>{a.inboundMissed}</span></td>
                  <td className={td}>{duration(a.talkSec)}</td>
                  <td className={td}>{duration(a.avgTalkSec)}</td>
                  <td className={td}>{a.interested}</td>
                  <td className={td}>{a.callbacksSet}</td>
                  <td className={td}>{a.notInterested}</td>
                  <td className={`${td} font-semibold`}>{a.won}</td>
                  <td className={td}>{a.conversionRate === null ? "—" : `${Math.round(a.conversionRate * 100)}%`}</td>
                  <td className={`${td} pr-5 ${a.callbackCompliance !== null && a.callbackCompliance < 0.8 ? "text-ember-ink" : ""}`}>
                    {a.callbackCompliance === null ? "—" : `${Math.round(a.callbackCompliance * 100)}%`} <span className="text-ink-4">({a.callbacksOnTime}/{a.callbacksDue})</span>
                  </td>
                </tr>
              ))}
              {agents.length === 0 && <tr><td colSpan={18} className="px-5 py-6 text-[13px] text-ink-3">No calls or logins in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel flush eyebrow="Per agent, per day" title="Day sheet" right={exportLink("agent_days")}>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-y border-rule text-left text-ink-3">
                <th className="px-5 py-2 font-medium">Day</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className={th}>Login</th>
                <th className={th}>First call</th>
                <th className={th}>Last call</th>
                <th className={th} title="Sign-out; blank when the agent didn't sign out">Logout</th>
                <th className={th} title="First → last call">Working span</th>
                <th className={th}>Dialled</th>
                <th className={th}>Connected</th>
                <th className={th}>Connect %</th>
                <th className={th}>Dialled / h</th>
                <th className={th}>Connected / h</th>
                <th className={th}>Talk time</th>
                <th className={th}>Won</th>
                <th className={`${th} pr-5`}>Callbacks on time</th>
              </tr>
            </thead>
            <tbody>
              {days.slice(0, DAY_SHEET_ROWS).map((d) => {
                const span = activeSecOf(d);
                return (
                  <tr key={`${d.agentId}:${d.day}`} className="border-b border-rule last:border-b-0">
                    <td className="px-5 py-2 whitespace-nowrap">{shortDay(d.day)}</td>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{d.name}</td>
                    <td className={td}>{timeIn(d.login, tz)}</td>
                    <td className={td}>{timeIn(d.firstCall, tz)}</td>
                    <td className={td}>{timeIn(d.lastCall, tz)}</td>
                    <td className={td}>{timeIn(d.logout, tz)}</td>
                    <td className={td}>{span ? duration(span) : "—"}</td>
                    <td className={td}>{d.dialled}</td>
                    <td className={td}>{d.connected}</td>
                    <td className={td}>{pctText(d.connected, d.dialled)}</td>
                    <td className={td}>{rate(perHour(d.dialled, span))}</td>
                    <td className={td}>{rate(perHour(d.connected, span))}</td>
                    <td className={td}>{duration(d.talkSec)}</td>
                    <td className={`${td} font-semibold`}>{d.won}</td>
                    <td className={`${td} pr-5`}>{d.callbacksDue ? `${d.callbacksOnTime}/${d.callbacksDue}` : "—"}</td>
                  </tr>
                );
              })}
              {days.length === 0 && <tr><td colSpan={15} className="px-5 py-6 text-[13px] text-ink-3">No calls or logins in this period.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="border-t border-rule px-5 py-2.5 text-[11.5px] text-ink-4">
          {days.length > DAY_SHEET_ROWS ? `Showing ${DAY_SHEET_ROWS} of ${days.length} rows — the CSV has all. ` : ""}
          Login and logout are recorded from 5 Oct 2026. Per-hour rates use the span from first to last call, at least 1 hour a day.
        </p>
      </Panel>
    </>
  );
}

function Sources({ rows, exportLink }: { rows: Awaited<ReturnType<typeof sourcesReport>>; exportLink: ExportLink }) {
  const th = "px-3 py-2 text-right font-medium whitespace-nowrap";
  const td = "px-3 py-2.5 text-right font-mono tnum";
  return (
    <Panel flush eyebrow="Leads created in this period" title="Which channels convert" right={exportLink("sources")}>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-y border-rule text-left text-ink-3">
              <th className="px-5 py-2 font-medium">Source</th>
              <th className={th}>Leads</th>
              <th className={th}>Called</th>
              <th className="px-3 py-2 font-medium">Reached</th>
              <th className={th}>Interested</th>
              <th className={th}>Won</th>
              <th className={th}>Conversion</th>
              <th className={th}>Lost</th>
              <th className={th}>Never called</th>
              <th className={`${th} pr-5`}>Median first call</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.source} className="border-b border-rule last:border-b-0">
                <td className="px-5 py-2.5 font-medium whitespace-nowrap">{SOURCE_LABEL[s.source] ?? s.source}</td>
                <td className={td}>{s.leads}</td>
                <td className={td}>{s.attempted}</td>
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2">
                    <span className="relative h-1.5 w-20 rounded-full bg-rule">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-teal-ink" style={{ width: `${s.leads ? (s.reached / s.leads) * 100 : 0}%` }} />
                    </span>
                    <span className="font-mono tnum">{pctText(s.reached, s.leads)}</span>
                  </span>
                </td>
                <td className={td}>{s.interested}</td>
                <td className={`${td} font-semibold`}>{s.won}</td>
                <td className={td}>{pctText(s.won, s.leads)}</td>
                <td className={td}>{s.lost}</td>
                <td className={`${td} ${s.neverCalled ? "text-ember-ink" : ""}`}>{s.neverCalled}</td>
                <td className={`${td} pr-5 ${s.medianFirstCallSec !== null && s.medianFirstCallSec > 300 ? "text-ember-ink" : ""}`}>{duration(s.medianFirstCallSec)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} className="px-5 py-6 text-[13px] text-ink-3">No leads in this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Calls({ data, exportLink }: { data: Awaited<ReturnType<typeof callsReport>>; exportLink: ExportLink }) {
  const k = data.kpis;
  const cb = data.callbacks;
  const firstHour = data.byHour.findIndex((h) => h.attempted || h.connected);
  const lastHour = 23 - [...data.byHour].reverse().findIndex((h) => h.attempted || h.connected);
  // Show the working hours (at least 9–20), not 24 mostly empty columns.
  const hours = data.byHour.slice(Math.min(firstHour < 0 ? 9 : firstHour, 9), Math.max(firstHour < 0 ? 20 : lastHour, 20) + 1);
  return (
    <>
      <Kpis
        items={[
          { label: "Dialled", value: String(k.dialled) },
          { label: "Connected", value: String(k.connected), note: `${pctText(k.connected, k.dialled)} of dials` },
          { label: "Inbound", value: String(k.inbound), note: `${k.inboundAnswered} answered` },
          { label: "Inbound missed", value: String(k.inboundMissed), alert: k.inboundMissed > 0 },
          { label: "Talk time", value: duration(k.talkSec), note: `avg ${duration(k.avgTalkSec)}` },
          { label: "Leads called", value: String(k.leadsCalled), note: `${k.agents} agents` },
          { label: "Callbacks on time", value: pctText(cb.onTime, cb.due), note: `${cb.onTime} of ${cb.due} due`, alert: cb.due > 0 && cb.onTime / cb.due < 0.8 },
          { label: "Overdue now", value: String(cb.overdueNow), note: "pending, past due", alert: cb.overdueNow > 0 },
        ]}
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Panel eyebrow="Volume" title="Calls by hour (all days)">
          <CallsByHour data={hours} currentHour={24} />
        </Panel>
        <Panel eyebrow="Volume" title="By weekday">
          <Bars rows={data.byWeekday.map((d) => ({ label: WEEKDAY[d.dow]!, value: d.dialled, note: `${pctText(d.connected, d.dialled)} conn.` }))} empty="No calls." />
        </Panel>
      </div>
      <Panel eyebrow="Trend" title="Dialled and connected per day" right={exportLink("calls")}>
        <DayColumns rows={data.byDay.map((d) => ({ day: d.day, a: d.dialled, b: d.connected }))} a="Dialled" b="Connected" />
      </Panel>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel eyebrow="Results" title="How calls ended">
          <Bars
            rows={data.results.map((r) => ({ label: `${r.direction === "inbound" ? "In · " : ""}${RESULT_LABEL[r.status] ?? r.status.replace(/_/g, " ")}`, value: r.count }))}
            empty="No finished calls."
          />
        </Panel>
        <Panel eyebrow="Outcomes" title="What agents recorded">
          <Bars rows={data.outcomes.map((o) => ({ label: o.label, value: o.count }))} empty="No outcomes recorded." />
        </Panel>
        <Panel eyebrow="Callbacks" title="Callback compliance">
          <Bars
            rows={[
              { label: "Called on time", value: cb.onTime, note: pctText(cb.onTime, cb.due) },
              { label: "Called late", value: cb.late, note: pctText(cb.late, cb.due) },
              { label: "Not called", value: cb.notCalled, note: pctText(cb.notCalled, cb.due) },
            ]}
            empty="No callbacks were due."
          />
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-4">On time = called from 5 minutes before to 15 minutes after it was due.</p>
        </Panel>
      </div>
    </>
  );
}
