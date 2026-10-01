/**
 * Setup — processes, telephony (click-to-call DIDs) and outbound webhooks.
 * Layout: a fixed index on the left, sections on the right, like a spec
 * sheet. Read-only in preview; editing arrives with T1.12–T1.17 and T2.9.
 */
import type { Metadata } from "next";
import { CircleAlert, CircleCheck, Copy, Plus } from "lucide-react";
import { Topbar } from "@/components/shell/topbar";
import { SectionTitle, StageTag, Tag } from "@/components/ui/primitives";
import { DIDS, PROCESSES, WEBHOOKS, ago } from "@/lib/ui/sample-data";

export const metadata: Metadata = { title: "Setup" };

const INDEX = [
  { id: "processes", label: "Processes", n: PROCESSES.length },
  { id: "telephony", label: "Telephony", n: DIDS.length },
  { id: "webhooks", label: "Webhooks", n: WEBHOOKS.length },
];

function AddButton({ label }: { label: string }) {
  return (
    <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-semibold text-sheet hover:bg-ink-2">
      <Plus size={14} /> {label}
    </button>
  );
}

export default function SetupPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar title="Setup" subtitle="Processes, telephony and integrations for this workspace" />
      <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-8 px-6 py-6">
        <nav className="sticky top-[84px] h-fit">
          <div className="eyebrow mb-2">On this page</div>
          <ol className="flex flex-col border-l border-rule">
            {INDEX.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="-ml-px flex items-center justify-between border-l-2 border-transparent py-1.5 pl-3 text-[13px] text-ink-2 hover:border-ink hover:text-ink">
                  <span><span className="mr-2 font-mono text-[11px] text-ink-4">{String(i + 1).padStart(2, "0")}</span>{s.label}</span>
                  <span className="font-mono text-[11px] text-ink-4">{s.n}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex max-w-[1040px] flex-col gap-10">
          {/* Processes */}
          <section id="processes" className="scroll-mt-24">
            <SectionTitle eyebrow="01" title="Processes" right={<AddButton label="New process" />} />
            <div className="mt-4 grid gap-3">
              {PROCESSES.map((p) => (
                <article key={p.id} className="panel grid grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
                  <div className="border-r border-rule p-4">
                    <div className="text-[14.5px] font-semibold">{p.name}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.stages.map((st) => <StageTag key={st} stage={st} />)}
                    </div>
                  </div>
                  {[
                    { k: "Assignment", v: p.method, sub: `${p.agents} agents` },
                    { k: "Open leads", v: String(p.open), sub: `dedupe by ${p.dedupe.toLowerCase()}`, mono: true },
                    { k: "Working hours", v: p.hours.split(" · ")[1]!, sub: p.hours.split(" · ")[0]!, mono: true },
                  ].map((c) => (
                    <div key={c.k} className="border-r border-rule p-4 last:border-r-0">
                      <div className="text-[11px] text-ink-3">{c.k}</div>
                      <div className={`mt-1 text-[14px] font-semibold ${c.mono ? "font-mono tnum" : ""}`}>{c.v}</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-4">{c.sub}</div>
                    </div>
                  ))}
                </article>
              ))}
            </div>
          </section>

          {/* Telephony */}
          <section id="telephony" className="scroll-mt-24">
            <SectionTitle eyebrow="02" title="Telephony · click-to-call" right={<AddButton label="Add number" />} />
            <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-ink-3">
              Calls run through CallerDesk&apos;s click-to-call API — no SIP, no browser audio. Outbound calls ring the agent&apos;s
              registered phone first; inbound calls are routed by the provider and matched to a process by the number dialled.
            </p>
            <div className="panel mt-4 overflow-hidden">
              <div className="flex items-center gap-3 border-b border-rule bg-paper/60 px-4 py-3">
                <Tag tone="teal"><span className="h-1.5 w-1.5 rounded-full bg-teal-ink" />Connected</Tag>
                <span className="text-[13px] font-semibold">CallerDesk</span>
                <span className="ml-auto flex items-center gap-2 font-mono text-[11.5px] text-ink-3">
                  …/api/hooks/kosmo/telephony/callerdesk?key=••••••
                  <Copy size={13} className="cursor-pointer hover:text-ink" />
                </span>
              </div>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-rule text-left text-[11.5px] text-ink-3">
                    <th className="px-4 py-2 font-medium">Number (DID)</th>
                    <th className="px-3 py-2 font-medium">Routes to</th>
                    <th className="px-3 py-2 font-medium">Direction</th>
                    <th className="px-4 py-2 text-right font-medium">Last call</th>
                  </tr>
                </thead>
                <tbody>
                  {DIDS.map((d) => (
                    <tr key={d.number} className="border-b border-rule last:border-b-0">
                      <td className="px-4 py-3 font-mono font-medium tnum">{d.number}</td>
                      <td className="px-3 py-3 text-ink-2">{d.process}</td>
                      <td className="px-3 py-3"><Tag>{d.direction}</Tag></td>
                      <td className="px-4 py-3 text-right font-mono text-[12px] text-ink-3 tnum">{ago(d.lastCall)} ago</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Webhooks */}
          <section id="webhooks" className="scroll-mt-24 pb-10">
            <SectionTitle eyebrow="03" title="Outbound webhooks" right={<AddButton label="Add endpoint" />} />
            <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-ink-3">
              Signed with HMAC-SHA256 (<span className="font-mono text-[12px]">X-AM2PM-Signature</span>), retried for 24 hours,
              paused automatically after a day of failures. See API.md §4.
            </p>
            <div className="mt-4 grid gap-3">
              {WEBHOOKS.map((w) => (
                <article key={w.url} className={`panel relative flex items-center gap-4 p-4 ${w.ok ? "" : "border-ember/50"}`}>
                  {!w.ok && <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-md bg-ember" />}
                  {w.ok ? <CircleCheck size={18} className="shrink-0 text-moss" /> : <CircleAlert size={18} className="shrink-0 text-ember" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12.5px]">{w.url}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {w.events.map((e) => <Tag key={e}>{e}</Tag>)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-mono text-[15px] font-semibold tnum ${w.ok ? "" : "text-ember-ink"}`}>{(w.rate * 100).toFixed(1)}%</div>
                    <div className="text-[11px] text-ink-3">delivered · last {ago(w.lastMin)} ago</div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
