"use client";

/**
 * Calls log table with inline recording player. Filters are URL params
 * (shareable); ▶ opens a player under the row that streams through
 * /api/v1/calls/{id}/recording (permission-checked, audited).
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { ArrowDownLeft, ArrowUpRight, Pause, Play, RefreshCw, Search, X } from "lucide-react";
import { syncCallsAction } from "@/app/(app)/calls/actions";
import { Tag } from "@/components/ui/primitives";
import type { CallRow } from "@/lib/calls/list";

const STATUS: Record<string, { label: string; tone: "moss" | "ember" | "muted" | "teal" }> = {
  completed: { label: "Connected", tone: "moss" },
  answered: { label: "Connected", tone: "moss" },
  missed: { label: "Missed", tone: "ember" },
  no_answer: { label: "Customer didn't answer", tone: "ember" },
  agent_no_answer: { label: "Agent didn't answer", tone: "ember" },
  busy: { label: "Busy", tone: "ember" },
  failed: { label: "Failed", tone: "ember" },
  unknown: { label: "No result yet", tone: "muted" },
  initiated: { label: "Ringing agent", tone: "teal" },
  agent_ringing: { label: "Ringing agent", tone: "teal" },
  customer_ringing: { label: "Ringing customer", tone: "teal" },
  ringing: { label: "Ringing", tone: "teal" },
};

const mmss = (s: number | null) => (s === null || s === undefined ? "—" : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);

export function CallsLog({
  rows,
  total,
  nextCursor,
  totals,
  agents,
  canSync,
  lastSync,
  timeZone,
}: {
  rows: CallRow[];
  total: number;
  nextCursor: string | null;
  totals: { calls: number; connected: number; talkSec: number; recordings: number };
  agents: { id: string; name: string }[];
  canSync: boolean;
  lastSync: { rows: number; failed: number; at: string } | null;
  timeZone: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const params = useMemo(() => Object.fromEntries(sp.entries()) as Record<string, string>, [sp]);
  const [pending, startTransition] = useTransition();
  const [playing, setPlaying] = useState<string | null>(null);
  const [q, setQ] = useState(params.q ?? "");
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const range = params.range ?? "7d";

  function go(next: Record<string, string>, keepCursor = false) {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k));
    if (!keepCursor) p.delete("cursor");
    startTransition(() => router.replace(`${pathname}?${p.toString()}`, { scroll: false }));
  }
  const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="panel grid shrink-0 grid-cols-2 md:grid-cols-4">
        {[
          { k: "Calls", v: totals.calls.toLocaleString("en-IN") },
          { k: "Connected", v: `${totals.connected.toLocaleString("en-IN")}${totals.calls ? ` · ${Math.round((totals.connected / totals.calls) * 100)}%` : ""}` },
          { k: "Talk time", v: mmss(totals.talkSec) },
          { k: "Recordings", v: totals.recordings.toLocaleString("en-IN") },
        ].map((x) => (
          <div key={x.k} className="border-r border-rule px-5 py-3.5 last:border-r-0">
            <div className="eyebrow">{x.k}</div>
            <div className="mt-1 font-mono text-[22px] font-semibold tnum">{x.v}</div>
          </div>
        ))}
      </section>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex h-9 items-center rounded-md border border-rule bg-sheet p-0.5">
          {[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All"]].map(([v, l]) => (
            <button key={v} onClick={() => go({ range: v === "7d" ? "" : v! })} className={`h-8 rounded-[4px] px-3 text-[12.5px] font-medium ${range === v ? "bg-ink text-sheet" : "text-ink-3 hover:text-ink"}`}>{l}</button>
          ))}
        </div>
        <select value={params.direction ?? ""} onChange={(e) => go({ direction: e.target.value })} aria-label="Direction" className="h-9 rounded-md border border-rule bg-sheet px-2.5 text-[12.5px]">
          <option value="">In & out</option>
          <option value="outbound">Outgoing</option>
          <option value="inbound">Incoming</option>
        </select>
        <select value={params.result ?? ""} onChange={(e) => go({ result: e.target.value })} aria-label="Result" className="h-9 rounded-md border border-rule bg-sheet px-2.5 text-[12.5px]">
          <option value="">Any result</option>
          <option value="connected">Connected</option>
          <option value="not_connected">Not connected</option>
          <option value="missed">Missed (incoming)</option>
        </select>
        {agents.length > 0 && (
          <select value={params.agent ?? ""} onChange={(e) => go({ agent: e.target.value })} aria-label="Agent" className="h-9 rounded-md border border-rule bg-sheet px-2.5 text-[12.5px]">
            <option value="">All agents</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <label className="flex h-9 items-center gap-1.5 rounded-md border border-rule bg-sheet px-2.5 text-[12.5px]">
          <input type="checkbox" checked={params.recording === "yes"} onChange={(e) => go({ recording: e.target.checked ? "yes" : "" })} className="accent-[var(--color-ink)]" /> With recording
        </label>
        <form onSubmit={(e) => (e.preventDefault(), go({ q: q.trim() }))} className="flex h-9 w-60 items-center gap-2 rounded-md border border-rule bg-sheet px-2.5 focus-within:border-ink">
          <Search size={14} className="text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Lead name or phone digits" className="w-full bg-transparent text-[12.5px] outline-none" aria-label="Search calls" />
          {q && <button type="button" onClick={() => (setQ(""), go({ q: "" }))} aria-label="Clear"><X size={13} className="text-ink-3" /></button>}
        </form>
        <div className="ml-auto flex items-center gap-3 text-[12px] text-ink-3">
          {lastSync && <span title={`${lastSync.rows} rows checked${lastSync.failed ? `, ${lastSync.failed} failed` : ""}`}>Synced with CallerDesk {new Date(lastSync.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone })}</span>}
          {canSync && (
            <button
              disabled={syncing}
              onClick={async () => {
                setSyncing(true);
                setSyncMsg(null);
                const r = await syncCallsAction();
                setSyncing(false);
                setSyncMsg(r.ok ? `Checked ${r.rows} call${r.rows === 1 ? "" : "s"} from CallerDesk${r.failed ? ` · ${r.failed} couldn't be matched (unmapped DID?)` : ""}` : r.error);
                startTransition(() => router.refresh());
              }}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule bg-sheet px-3 font-medium text-ink-2 hover:border-ink-3 disabled:opacity-50"
            >
              <RefreshCw size={13} className={syncing ? "animate-spin" : ""} /> {syncing ? "Syncing…" : "Sync now"}
            </button>
          )}
        </div>
      </div>
      {syncMsg && <p className="rounded-md bg-teal/15 px-3 py-2 text-[12.5px]">{syncMsg}</p>}

      <div className={`panel min-h-0 flex-1 overflow-auto overscroll-contain transition-opacity ${pending ? "opacity-60" : ""}`}>
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr className="text-left text-[11.5px] text-ink-3 [&>th]:sticky [&>th]:top-0 [&>th]:z-10 [&>th]:border-b [&>th]:border-rule [&>th]:bg-sheet">
              <th className="w-12 px-3 py-2.5" />
              <th className="px-3 py-2.5 font-medium">When</th>
              <th className="px-3 py-2.5 font-medium">Lead</th>
              <th className="px-3 py-2.5 font-medium">Number</th>
              <th className="px-3 py-2.5 font-medium">Agent</th>
              <th className="px-3 py-2.5 font-medium">Result</th>
              <th className="px-3 py-2.5 text-right font-medium">Duration</th>
              <th className="px-3 py-2.5 text-right font-medium">Talk</th>
              <th className="px-3 py-2.5 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const st = STATUS[c.status] ?? { label: c.status.replace(/_/g, " "), tone: "muted" as const };
              const open = playing === c.id;
              return [
                <tr key={c.id} className={`[&>td]:border-b [&>td]:border-rule ${open ? "bg-paper" : "hover:bg-paper/60"}`}>
                  <td className="px-3 py-2">
                    {c.hasRecording ? (
                      <button onClick={() => setPlaying(open ? null : c.id)} aria-label={open ? "Close player" : "Play recording"} title={open ? "Close player" : "Play recording"} className={`inline-flex h-8 w-8 items-center justify-center rounded-full ${open ? "bg-ink text-sheet" : "bg-teal/25 text-ink hover:bg-teal/45"}`}>
                        {open ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
                      </button>
                    ) : (
                      <span className="inline-flex h-8 w-8 items-center justify-center text-ink-4" title="No recording">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {c.direction === "inbound" ? <ArrowDownLeft size={13} className="text-teal-ink" /> : <ArrowUpRight size={13} className="text-ink-3" />}
                      <span className="font-mono text-[12px] tnum">{when(c.startedAt)}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2">{c.leadId ? <Link href={`/console?lead=${c.leadId}`} className="font-medium hover:underline">{c.leadName ?? "Lead"}</Link> : <span className="text-ink-4">—</span>}</td>
                  <td className="px-3 py-2 font-mono text-[12px] whitespace-nowrap tnum">{c.customer}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-2">{c.agentName ?? <span className="text-ink-4">—</span>}</td>
                  <td className="px-3 py-2"><Tag tone={st.tone}>{st.label}</Tag></td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] tnum">{mmss(c.durationSec)}</td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] tnum">{mmss(c.talkSec)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-2">{c.outcome ?? <span className="text-ink-4">—</span>}</td>
                </tr>,
                open && (
                  <tr key={`${c.id}-player`} className="bg-paper [&>td]:border-b [&>td]:border-rule">
                    <td />
                    <td colSpan={8} className="px-3 pb-3">
                      <audio controls autoPlay preload="none" src={`/api/v1/calls/${c.id}/recording`} className="h-10 w-full max-w-[720px]">
                        Your browser can’t play this recording.
                      </audio>
                    </td>
                  </tr>
                ),
              ];
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-14 text-center text-[13px] text-ink-3">
                  No calls here yet.{canSync ? " If calls were made but don’t show, click Sync now." : ""}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-rule pt-2 text-[12.5px] text-ink-3">
        <span className="font-mono tnum">{rows.length ? `${rows.length} of ${total.toLocaleString("en-IN")}` : ""}</span>
        <span className="flex gap-2">
          {params.cursor && <button onClick={() => go({})} className="h-8 rounded-md border border-rule bg-sheet px-3 font-medium text-ink-2 hover:border-ink-3">← Newest</button>}
          {nextCursor && <button onClick={() => go({ cursor: nextCursor }, true)} className="h-8 rounded-md border border-rule bg-sheet px-3 font-medium text-ink-2 hover:border-ink-3">Older →</button>}
        </span>
      </div>
    </div>
  );
}
