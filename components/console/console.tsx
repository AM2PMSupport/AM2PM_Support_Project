"use client";

/**
 * Agent console — three panes:
 *   queue (what to call next) · lead (call + outcome) · timeline (what happened)
 *
 * Queue order follows PRD FR-18: callbacks due now → missed calls → fresh
 * leads → the rest. Keyboard: J/K move through the queue, C calls, 1–8 pick
 * an outcome, Enter saves.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, AtSign, MapPin, PhoneMissed, Repeat2 } from "lucide-react";
import { CallControl, type CallPhase } from "@/components/console/call-control";
import { DispositionPanel } from "@/components/console/disposition-panel";
import { SlaRing } from "@/components/console/sla-ring";
import { Kbd, StageTag, Tag } from "@/components/ui/primitives";
import { ME, QUEUE, SOURCE_LABEL, ago, formatPhone, timelineFor, type QueueLead, type TimelineItem } from "@/lib/ui/sample-data";

type Filter = "due" | "new" | "all";

function priority(l: QueueLead): number {
  if (l.callbackInMin !== undefined && l.callbackInMin <= 0) return 0;
  if (l.missedCall) return 1;
  if (l.attempts === 0) return 2;
  return 3;
}

export function Console() {
  const [filter, setFilter] = useState<Filter>("all");
  const [done, setDone] = useState<Record<string, string>>({});
  const sorted = useMemo(
    () => [...QUEUE].sort((a, b) => priority(a) - priority(b) || (a.callbackInMin ?? 9e9) - (b.callbackInMin ?? 9e9) || a.ageMin - b.ageMin),
    [],
  );
  const visible = sorted.filter((l) =>
    filter === "due" ? priority(l) <= 1 : filter === "new" ? l.attempts === 0 : true,
  );
  const [selectedId, setSelectedId] = useState(sorted[0]!.id);
  const lead = QUEUE.find((l) => l.id === selectedId)!;
  const [phase, setPhase] = useState<CallPhase>("idle");

  // Selecting a lead resets the call state (the call/outcome panels remount by key).
  const select = useCallback((id: string) => {
    setSelectedId(id);
    setPhase("idle");
  }, []);

  const counts = { due: sorted.filter((l) => priority(l) <= 1).length, new: sorted.filter((l) => l.attempts === 0).length, all: sorted.length };

  // J / K to move through the queue.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      const i = visible.findIndex((l) => l.id === selectedId);
      if (e.key === "j" && i < visible.length - 1) select(visible[i + 1]!.id);
      if (e.key === "k" && i > 0) select(visible[i - 1]!.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selectedId, select]);

  const onSaved = useCallback(
    (label: string, when?: string) => setDone((d) => ({ ...d, [selectedId]: when ? `${label} · ${when}` : label })),
    [selectedId],
  );

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)_320px]">
      {/* ---------------- Queue */}
      <aside className="flex min-h-0 flex-col border-r border-rule bg-sheet">
        <div className="flex items-center gap-1 border-b border-rule p-2">
          {(["all", "due", "new"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[5px] text-[12.5px] font-medium transition ${
                filter === f ? "bg-ink text-sheet" : "text-ink-3 hover:bg-paper hover:text-ink"
              }`}
            >
              {f === "all" ? "My queue" : f === "due" ? "Due now" : "New"}
              <span className={`font-mono text-[11px] ${filter === f ? "text-teal" : f === "due" ? "text-ember" : "text-ink-4"}`}>{counts[f]}</span>
            </button>
          ))}
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto">
          {visible.map((l) => {
            const overdue = l.callbackInMin !== undefined && l.callbackInMin <= 0;
            const fraction = overdue ? 1 : l.callbackInMin !== undefined ? 1 - l.callbackInMin / 240 : Math.min(l.ageMin / 30, 1);
            const active = l.id === selectedId;
            return (
              <li key={l.id}>
                <button
                  onClick={() => select(l.id)}
                  className={`relative flex w-full items-center gap-3 border-b border-rule px-3 py-3 text-left transition ${
                    active ? "bg-paper" : "hover:bg-paper/60"
                  }`}
                >
                  {active && <span className="absolute inset-y-0 left-0 w-[3px] bg-ink" />}
                  <SlaRing fraction={fraction} overdue={overdue} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`truncate text-[13.5px] font-semibold ${done[l.id] ? "text-ink-3 line-through decoration-ink-4" : ""}`}>{l.name}</span>
                      {l.missedCall && <PhoneMissed size={13} className="shrink-0 text-ember" aria-label="Missed call" />}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">
                      {SOURCE_LABEL[l.source]} · {l.city}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className={`block font-mono text-[11.5px] tnum ${overdue ? "font-semibold text-ember-ink" : "text-ink-3"}`}>
                      {overdue ? `-${ago(-l.callbackInMin!)}` : l.callbackInMin !== undefined ? `in ${ago(l.callbackInMin)}` : ago(l.ageMin)}
                    </span>
                    <span className="mt-1 block">
                      <StageTag stage={l.stage} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-3 border-t border-rule px-3 py-2 text-[11px] text-ink-3">
          <span className="inline-flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
          <span className="inline-flex items-center gap-1"><Kbd>C</Kbd> call</span>
          <span className="inline-flex items-center gap-1"><Kbd>1</Kbd>–<Kbd>8</Kbd> outcome</span>
        </div>
      </aside>

      {/* ---------------- Lead */}
      <main className="min-h-0 overflow-y-auto px-8 py-7">
        <div className="mx-auto flex max-w-[760px] flex-col gap-5">
          <header>
            <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-3">
              <span className="font-mono">{lead.id}</span>
              <span>·</span>
              <span>{lead.process}</span>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-[30px] font-semibold leading-none tracking-[-0.02em]">{lead.name}</h2>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
                  <span className="font-mono text-[18px] font-medium tracking-tight text-ink tnum">{formatPhone(lead.phone)}</span>
                  <span className="inline-flex items-center gap-1"><MapPin size={13} className="text-ink-4" />{lead.city}</span>
                  {lead.email && <span className="inline-flex items-center gap-1"><AtSign size={13} className="text-ink-4" />{lead.email}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <StageTag stage={lead.stage} />
                <Tag>{SOURCE_LABEL[lead.source]}</Tag>
                {lead.attempts > 0 && (
                  <Tag><Repeat2 size={11} />{lead.attempts} attempt{lead.attempts > 1 ? "s" : ""}</Tag>
                )}
              </div>
            </div>
          </header>

          {lead.callbackInMin !== undefined && lead.callbackInMin <= 0 && (
            <div className="flex items-center gap-3 rounded-md border-l-[3px] border-ember bg-ember-wash px-4 py-2.5 text-[13px] text-ember-ink">
              <span className="font-semibold">Callback overdue by {ago(-lead.callbackInMin)}</span>
              <span className="text-ember-ink/80">Last outcome: {lead.lastDisposition}</span>
            </div>
          )}
          {done[lead.id] && (
            <div className="rounded-md border-l-[3px] border-moss bg-moss-wash px-4 py-2.5 text-[13px] text-moss">
              Saved: <span className="font-semibold">{done[lead.id]}</span> — press <Kbd>J</Kbd> for the next lead.
            </div>
          )}

          <CallControl key={`call-${lead.id}`} did={ME.did} dnc={lead.dnc} onPhaseChange={setPhase} />

          <DispositionPanel key={`out-${lead.id}`} enabled={phase === "ended"} onSaved={onSaved} />

          <section className="panel">
            <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
              <span className="eyebrow">Details</span>
              {lead.campaign && <span className="text-[11.5px] text-ink-3">Campaign · {lead.campaign}</span>}
            </div>
            <dl className="grid grid-cols-3">
              {Object.entries(lead.custom).map(([k, v]) => (
                <div key={k} className="border-r border-b border-rule px-4 py-3 [&:nth-child(3n)]:border-r-0">
                  <dt className="text-[11px] text-ink-3">{k}</dt>
                  <dd className="mt-0.5 text-[14px] font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </main>

      {/* ---------------- Timeline */}
      <aside className="min-h-0 overflow-y-auto border-l border-rule bg-sheet px-5 py-6">
        <div className="eyebrow mb-4">Timeline</div>
        <Timeline items={timelineFor(lead)} />
        <a className="mt-6 inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink" href="#">
          Full history <ArrowUpRight size={13} />
        </a>
      </aside>
    </div>
  );
}

const NODE: Record<NonNullable<TimelineItem["tone"]>, string> = {
  teal: "bg-teal",
  ember: "bg-ember",
  moss: "bg-moss",
  ink: "bg-ink-3",
};

function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="relative">
      <span className="absolute left-[4px] top-2 bottom-2 w-px bg-rule" />
      {items.map((t) => (
        <li key={t.id} className="relative mb-5 pl-6 last:mb-0">
          <span className={`absolute left-0 top-[5px] h-[9px] w-[9px] rounded-full ring-[3px] ring-sheet ${NODE[t.tone ?? "ink"]}`} />
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold leading-snug">{t.title}</span>
            <span className="shrink-0 font-mono text-[11px] text-ink-4 tnum">{ago(t.agoMin)}</span>
          </div>
          {t.detail && <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{t.detail}</p>}
          {t.by && <p className="mt-0.5 text-[11px] text-ink-4">by {t.by}</p>}
        </li>
      ))}
    </ol>
  );
}
