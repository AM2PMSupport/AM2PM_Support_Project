/**
 * Floor — the supervisor's live view on real data: today's numbers (tenant
 * timezone), calls by hour, who is doing what, where leads drop out, and
 * which sources convert. Server-rendered per request; refreshes every 60 s.
 */
import type { Metadata } from "next";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { CallsByHour, CapacityRing, Funnel } from "@/components/dashboard/charts";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { Topbar } from "@/components/shell/topbar";
import { Avatar, SectionTitle } from "@/components/ui/primitives";
import { getFloor } from "@/lib/reports/floor";
import { STATUS_META } from "@/lib/ui/status";
import type { AgentStatus } from "@/lib/ui/sample-data";

export const metadata: Metadata = { title: "Floor" };
export const dynamic = "force-dynamic";

const SOURCE: Record<string, string> = {
  meta_ads: "Meta Ads", web_form: "Website", indiamart: "IndiaMART", justdial: "Justdial", inbound_call: "Inbound call",
  csv: "CSV import", google_ads: "Google Ads", sheet: "Google Sheet", api: "API", manual: "Manual",
};
const ORDER: AgentStatus[] = ["on_call", "wrap_up", "available", "break", "offline"];

/** Change vs yesterday at the same time of day. */
function Delta({ now, before }: { now: number; before: number }) {
  if (!before) return <span className="text-[11.5px] text-ink-4">—</span>;
  const d = (now - before) / before;
  const Icon = d >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono text-[11.5px] ${d >= 0 ? "text-moss" : "text-ember-ink"}`}>
      <Icon size={12} />
      {Math.abs(Math.round(d * 100))}%
    </span>
  );
}

const mmss = (sec: number | null) => (sec === null ? "—" : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

export default async function FloorPage() {
  const ctx = await requirePage("dashboard");
  const f = await getFloor(ctx);
  const k = f.kpis;
  const connectRate = k.attempted ? k.connected / k.attempted : null;
  const peak = f.byHour.reduce((a, b) => (b.connected > a.connected ? b : a), f.byHour[0]!);
  const wide = ctx.actor.role === "admin" || ctx.actor.role === "super_admin";

  const kpis = [
    { label: "Leads in today", value: String(k.leadsToday), delta: <Delta now={k.leadsToday} before={k.leadsYesterdaySoFar} />, note: "vs yesterday, same time", alert: false },
    { label: "Connect rate", value: connectRate === null ? "—" : `${(connectRate * 100).toFixed(1)}%`, delta: null, note: `${k.connected} of ${k.attempted} dials`, alert: false },
    { label: "Conversions", value: String(k.conversions), delta: <Delta now={k.conversions} before={k.conversionsYesterday} />, note: "won today", alert: false },
    { label: "Median first call", value: mmss(k.medianFirstCallSec), delta: null, note: "lead in → first dial (m:ss)", alert: false },
    { label: "Overdue callbacks", value: String(k.overdueCallbacks), delta: null, note: "past due, not called", alert: k.overdueCallbacks > 0 },
    { label: "Unassigned", value: String(k.unassigned), delta: null, note: "waiting for an agent", alert: k.unassigned > 0 },
  ];

  const agents = [...f.agents].sort((a, b) => ORDER.indexOf(a.status as AgentStatus) - ORDER.indexOf(b.status as AgentStatus));

  return (
    <div className="flex min-h-dvh flex-col">
      <AutoRefresh seconds={60} />
      <Topbar title="Floor" subtitle={`Today · ${ctx.timezone} · ${wide ? "all processes" : "your processes"}`} />

      <div className="flex flex-col gap-6 px-6 py-6">
        <section className="panel grid grid-cols-3 xl:grid-cols-6">
          {kpis.map((x) => (
            <div key={x.label} className="relative border-r border-b border-rule px-5 py-4 last:border-r-0 xl:border-b-0">
              {x.alert && <span className="absolute inset-x-0 top-0 h-[3px] bg-ember" />}
              <div className="eyebrow">{x.label}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className={`font-mono text-[28px] font-semibold leading-none tracking-tight tnum ${x.alert ? "text-ember-ink" : ""}`}>{x.value}</span>
                {x.delta}
              </div>
              <div className="mt-1.5 text-[11.5px] text-ink-4">{x.note}</div>
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
            <div className="mt-4"><CallsByHour data={f.byHour} currentHour={f.currentHour} /></div>
            <dl className="mt-4 grid grid-cols-4 border-t border-rule pt-4">
              {[
                { k: "Attempted", v: String(k.attempted) },
                { k: "Connected", v: String(k.connected) },
                { k: "Avg talk", v: mmss(k.avgTalkSec) },
                { k: "Peak hour", v: peak.connected ? `${String(peak.hour).padStart(2, "0")}:00` : "—" },
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
              <SectionTitle eyebrow="Right now" title="Agents on the floor" right={<span className="font-mono text-[12px] text-ink-3">{agents.filter((a) => a.status !== "offline").length}/{agents.length} in</span>} />
            </div>
            <ul className="flex-1">
              {agents.map((a) => {
                const meta = STATUS_META[a.status as AgentStatus] ?? STATUS_META.offline;
                return (
                  <li key={a.id} className="grid grid-cols-[28px_1fr_auto_auto] items-center gap-3 border-t border-rule px-5 py-2.5">
                    <Avatar initials={initials(a.name)} tone={a.status === "on_call" ? "teal" : "ink"} size={28} />
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold">{a.name}</div>
                      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                        {meta.label}
                      </div>
                    </div>
                    <div className="text-right font-mono text-[11.5px] leading-tight tnum text-ink-2">
                      <div>{a.calls} calls · {a.talkMin}m</div>
                      <div className="text-ink-4">{a.conversions} won</div>
                    </div>
                    <CapacityRing open={a.openLeads} max={Math.max(a.maxOpen, 1)} />
                  </li>
                );
              })}
              {agents.length === 0 && <li className="border-t border-rule px-5 py-6 text-[13px] text-ink-3">No agents in your processes yet.</li>}
            </ul>
          </section>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <section className="panel p-5">
            <SectionTitle eyebrow="Today" title="Where leads drop out" />
            <div className="mt-5"><Funnel data={f.funnel} /></div>
            <p className="mt-4 text-[12px] leading-relaxed text-ink-3">Orange % = less than half carried on from the previous stage.</p>
          </section>

          <section className="panel overflow-hidden">
            <div className="p-5 pb-3"><SectionTitle eyebrow="Sources" title="Which channels convert (today)" /></div>
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
                {f.sources.map((s) => (
                  <tr key={s.source} className="border-b border-rule last:border-b-0">
                    <td className="px-5 py-2.5 font-medium">{SOURCE[s.source] ?? s.source}</td>
                    <td className="px-3 py-2.5 text-right font-mono tnum">{s.leads}</td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2">
                        <span className="relative h-1.5 w-24 rounded-full bg-rule">
                          <span className="absolute inset-y-0 left-0 rounded-full bg-teal-ink" style={{ width: `${s.connectRate * 100}%` }} />
                        </span>
                        <span className="font-mono tnum">{Math.round(s.connectRate * 100)}%</span>
                      </span>
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono tnum ${s.avgFirstCallMin !== null && s.avgFirstCallMin > 5 ? "text-ember-ink" : ""}`}>{s.avgFirstCallMin === null ? "—" : `${s.avgFirstCallMin}m`}</td>
                    <td className="px-5 py-2.5 text-right font-mono font-semibold tnum">{s.conversions}</td>
                  </tr>
                ))}
                {f.sources.length === 0 && <tr><td colSpan={5} className="px-5 py-6 text-[13px] text-ink-3">No leads today yet.</td></tr>}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}
