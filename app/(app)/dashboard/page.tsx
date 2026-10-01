/**
 * Floor — the supervisor's live view: today's numbers, call volume by hour,
 * who is doing what right now, and where leads drop out.
 */
import type { Metadata } from "next";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { CallsByHour, CapacityRing, Funnel } from "@/components/dashboard/charts";
import { Topbar } from "@/components/shell/topbar";
import { Avatar, SectionTitle } from "@/components/ui/primitives";
import { AGENTS, CALLS_BY_HOUR, KPIS, SOURCES, SOURCE_LABEL, type AgentStatus } from "@/lib/ui/sample-data";
import { STATUS_META } from "@/lib/ui/status";

export const metadata: Metadata = { title: "Floor" };

function Delta({ value, pct = true, invert = false }: { value: number; pct?: boolean; invert?: boolean }) {
  const good = invert ? value < 0 : value > 0;
  const Icon = value >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono text-[11.5px] ${good ? "text-moss" : "text-ember-ink"}`}>
      <Icon size={12} />
      {pct ? `${Math.abs(Math.round(value * 1000) / 10)}%` : Math.abs(value)}
    </span>
  );
}

const ORDER: AgentStatus[] = ["on_call", "wrap_up", "available", "break", "offline"];

export default function FloorPage() {
  const done = CALLS_BY_HOUR.filter((h) => h.attempted !== null);
  const attempted = done.reduce((n, h) => n + (h.attempted ?? 0), 0);
  const connected = done.reduce((n, h) => n + h.connected, 0);
  const peak = done.reduce((a, b) => (b.connected > a.connected ? b : a));
  const firstCall = `${Math.floor(KPIS.medianFirstCallSec / 60)}:${String(KPIS.medianFirstCallSec % 60).padStart(2, "0")}`;
  const kpis = [
    { label: "Leads in today", value: String(KPIS.leadsToday), delta: <Delta value={KPIS.leadsDelta} />, note: "vs last Thursday" },
    { label: "Connect rate", value: `${(KPIS.connectRate * 100).toFixed(1)}%`, delta: <Delta value={KPIS.connectDelta} />, note: "connected ÷ attempted" },
    { label: "Conversions", value: String(KPIS.conversions), delta: <Delta value={KPIS.conversionsDelta} pct={false} />, note: "order placed / won" },
    { label: "Median first call", value: firstCall, delta: <span className="text-[11.5px] text-ink-3">min</span>, note: "lead in → first dial" },
    { label: "Overdue callbacks", value: String(KPIS.overdueCallbacks), delta: null, note: "past due, not called", alert: KPIS.overdueCallbacks > 0 },
    { label: "Unassigned", value: String(KPIS.unassigned), delta: null, note: "waiting for an agent", alert: KPIS.unassigned > 0 },
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar title="Floor" subtitle="Thursday · all processes · live" />

      <div className="flex flex-col gap-6 px-6 py-6">
        {/* KPI strip: one ruled row, not six cards */}
        <section className="panel grid grid-cols-3 xl:grid-cols-6">
          {kpis.map((k) => (
            <div key={k.label} className="relative border-r border-b border-rule px-5 py-4 last:border-r-0 xl:border-b-0">
              {k.alert && <span className="absolute inset-x-0 top-0 h-[3px] bg-ember" />}
              <div className="eyebrow">{k.label}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className={`font-mono text-[28px] font-semibold leading-none tracking-tight tnum ${k.alert ? "text-ember-ink" : ""}`}>{k.value}</span>
                {k.delta}
              </div>
              <div className="mt-1.5 text-[11.5px] text-ink-4">{k.note}</div>
            </div>
          ))}
        </section>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <section className="panel flex flex-col p-5">
            <SectionTitle
              eyebrow="Volume"
              title="Calls by hour"
              right={
                <div className="flex items-center gap-4 text-[11.5px] text-ink-3">
                  <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-teal-ink" />Connected</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] border border-ink-3" />Attempted</span>
                </div>
              }
            />
            <div className="mt-4">
              <CallsByHour />
            </div>
            <dl className="mt-4 grid grid-cols-4 border-t border-rule pt-4">
              {[
                { k: "Attempted", v: String(attempted) },
                { k: "Connected", v: String(connected) },
                { k: "Avg talk", v: "3:04" },
                { k: "Peak hour", v: `${String(peak.hour).padStart(2, "0")}:00` },
              ].map((x) => (
                <div key={x.k}>
                  <dt className="text-[11px] text-ink-3">{x.k}</dt>
                  <dd className="mt-0.5 font-mono text-[18px] font-semibold tnum">{x.v}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="panel flex flex-col">
            <div className="p-5 pb-3">
              <SectionTitle eyebrow="Right now" title="Agents on the floor" right={<span className="font-mono text-[12px] text-ink-3">{AGENTS.filter((a) => a.status !== "offline").length}/{AGENTS.length} in</span>} />
            </div>
            <ul className="flex-1">
              {[...AGENTS]
                .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
                .map((a) => (
                  <li key={a.id} className="grid grid-cols-[28px_1fr_auto_auto] items-center gap-3 border-t border-rule px-5 py-2.5">
                    <Avatar initials={a.initials} tone={a.status === "on_call" ? "teal" : "ink"} size={28} />
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold">{a.name}</div>
                      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_META[a.status].dot} ${a.status === "on_call" ? "live-dot text-ember" : ""}`} />
                        {STATUS_META[a.status].label}
                        <span className="font-mono text-ink-4">{a.forMin}m</span>
                      </div>
                    </div>
                    <div className="text-right font-mono text-[11.5px] leading-tight tnum text-ink-2">
                      <div>{a.calls} calls</div>
                      <div className="text-ink-4">{a.conversions} won</div>
                    </div>
                    <CapacityRing open={a.openLeads} max={a.maxOpen} />
                  </li>
                ))}
            </ul>
          </section>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <section className="panel p-5">
            <SectionTitle eyebrow="Today" title="Where leads drop out" />
            <div className="mt-5">
              <Funnel />
            </div>
            <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
              Orange % = less than half carried on from the previous stage.
            </p>
          </section>

          <section className="panel overflow-hidden">
            <div className="p-5 pb-3">
              <SectionTitle eyebrow="Sources" title="Which channels convert" />
            </div>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-y border-rule text-left text-ink-3">
                  <th className="px-5 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 text-right font-medium">Leads</th>
                  <th className="px-3 py-2 font-medium">Connect rate</th>
                  <th className="px-3 py-2 text-right font-medium">First call</th>
                  <th className="px-5 py-2 text-right font-medium">Won</th>
                </tr>
              </thead>
              <tbody>
                {SOURCES.map((s) => (
                  <tr key={s.source} className="border-b border-rule last:border-b-0">
                    <td className="px-5 py-2.5 font-medium">{SOURCE_LABEL[s.source]}</td>
                    <td className="px-3 py-2.5 text-right font-mono tnum">{s.leads}</td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2">
                        <span className="relative h-1.5 w-24 rounded-full bg-rule">
                          <span className="absolute inset-y-0 left-0 rounded-full bg-teal-ink" style={{ width: `${s.connectRate * 100}%` }} />
                        </span>
                        <span className="font-mono tnum">{Math.round(s.connectRate * 100)}%</span>
                      </span>
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono tnum ${s.avgFirstCallMin > 5 ? "text-ember-ink" : ""}`}>{s.avgFirstCallMin.toFixed(1)}m</td>
                    <td className="px-5 py-2.5 text-right font-mono font-semibold tnum">{s.conversions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}
