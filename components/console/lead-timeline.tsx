"use client";

/**
 * Lead timeline with a quick filter: type chips (calls, outcomes, stage,
 * edits, recordings) + free-text search over title / detail / who. Used in
 * the console's right column on wide screens and inside the lead column on
 * smaller ones. Filtering is instant (client-side; the timeline is ≤ 80 rows).
 */
import { useState } from "react";
import { Play, Search, X } from "lucide-react";
import type { TimelineEntry } from "@/lib/agent/queue";

const KINDS = [
  { id: "all", label: "All", match: () => true },
  { id: "calls", label: "Calls", match: (t: TimelineEntry) => t.kind === "call" },
  { id: "outcomes", label: "Outcomes", match: (t: TimelineEntry) => t.kind === "disposition_set" || t.kind === "callback_set" || /^Outcome/.test(t.title) },
  { id: "stage", label: "Stage", match: (t: TimelineEntry) => ["stage_changed", "converted", "lost", "restored"].includes(t.kind) },
  { id: "edits", label: "Edits", match: (t: TimelineEntry) => ["edited", "assigned", "reassigned", "merged", "created", "deleted"].includes(t.kind) },
  { id: "recordings", label: "Recordings", match: (t: TimelineEntry) => !!t.hasRecording },
] as const;

function ago(iso: string, now: number) {
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export function LeadTimeline({ items, now }: { items: TimelineEntry[]; now: number }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("all");
  const [q, setQ] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();
  const k = KINDS.find((x) => x.id === kind)!;
  const shown = items.filter((t) => k.match(t) && (!needle || `${t.title} ${t.detail ?? ""} ${t.by ?? ""}`.toLowerCase().includes(needle)));

  return (
    <div className="flex flex-col gap-3">
      <label className="flex h-8 items-center gap-2 rounded-md border border-rule bg-paper/60 px-2.5 focus-within:border-ink">
        <Search size={13} className="text-ink-4" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search timeline (e.g. busy, stage, Ranjan)" className="w-full bg-transparent text-[12px] outline-none placeholder:text-ink-4" aria-label="Search timeline" />
        {q && <button onClick={() => setQ("")} aria-label="Clear"><X size={12} className="text-ink-3" /></button>}
      </label>
      <div className="flex flex-wrap gap-1">
        {KINDS.map((x) => {
          const n = items.filter((t) => x.match(t)).length;
          if (x.id !== "all" && !n) return null;
          return (
            <button key={x.id} onClick={() => setKind(x.id)} className={`h-6 rounded-full px-2.5 text-[11.5px] font-medium ${kind === x.id ? "bg-ink text-sheet" : "bg-paper text-ink-3 hover:text-ink"}`}>
              {x.label} <span className="font-mono opacity-70">{n}</span>
            </button>
          );
        })}
      </div>
      {shown.length ? (
        <ol className="relative">
          <span className="absolute top-2 bottom-2 left-[4px] w-px bg-rule" />
          {shown.map((t) => (
            <li key={t.id} className="relative mb-5 pl-6 last:mb-0">
              <span className={`absolute top-[5px] left-0 h-[9px] w-[9px] rounded-full ring-[3px] ring-sheet ${t.tone === "teal" ? "bg-teal" : t.tone === "ember" ? "bg-ember" : t.tone === "moss" ? "bg-moss" : "bg-ink-3"}`} />
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] leading-snug font-semibold">{t.title}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink-4 tnum" title={new Date(t.at).toLocaleString("en-IN")}>{ago(t.at, now)}</span>
              </div>
              {t.detail && <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{t.detail}</p>}
              {t.hasRecording && t.callId &&
                (playing === t.callId ? (
                  <audio controls autoPlay preload="none" src={`/api/v1/calls/${t.callId}/recording`} className="mt-1.5 h-8 w-full" onEnded={() => setPlaying(null)} />
                ) : (
                  <button onClick={() => setPlaying(t.callId!)} className="mt-1 inline-flex items-center gap-1 rounded-full bg-teal/25 px-2 py-0.5 text-[11.5px] font-medium hover:bg-teal/45">
                    <Play size={11} /> Play recording
                  </button>
                ))}
              {t.by && <p className="mt-0.5 text-[11px] text-ink-4">by {t.by}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[12.5px] text-ink-4">{items.length ? "Nothing matches this filter." : "No activity yet."}</p>
      )}
    </div>
  );
}
