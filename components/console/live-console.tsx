"use client";

/**
 * Agent console on live data — queue · lead · timeline.
 *
 * Live updates by polling (ARCHITECTURE.md §2.1 / T1.40):
 *   - during a call: call status every 2 s (webhooks move it server-side)
 *   - otherwise: queue + "do I have a live call?" every 20 s, which also
 *     opens the lead of an inbound call answered on the agent's phone
 *     (screen-pop, T1.38a).
 * Keyboard: J/K queue · C call (Shift+C: Mobile 2) · 1–9 outcome · Enter save.
 * Two numbers (Mobile 2) → one Call button per number. Leads-row call icons
 * open the console with `dial=primary|alt`, which places that call once on
 * arrival (the agent clicked Call — this is not auto-dialling, RULE.md §6.1).
 * Queue filter (search · stage · source · tabs) narrows the list, and
 * Prev/Next in the lead header steps through exactly that filtered list.
 * Details are edited in place (components/console/lead-details.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AtSign, Check, ChevronLeft, ChevronRight, Filter, CornerDownLeft, Phone, PhoneIncoming, PhoneMissed, PhoneOff, Repeat2, Search, Smartphone, X } from "lucide-react";
import { callStatusAction, endStuckCallAction, leadAction, queueAction, saveOutcomeAction, setStageAction, startCallAction } from "@/app/(app)/console/actions";
import { LeadDetails } from "@/components/console/lead-details";
import { LeadTimeline } from "@/components/console/lead-timeline";
import { ProcessPicker } from "@/components/ui/process-picker";
import { FilterPanel, type FilterOptions } from "@/components/leads/filter-panel";
import { AppliedFilters, appliedChips } from "@/components/leads/applied-filters";
import { SlaRing } from "@/components/console/sla-ring";
import { ErrorNote } from "@/components/ui/form";
import { Kbd, StageTag, Tag } from "@/components/ui/primitives";
import type { LeadDetail, QueueItem } from "@/lib/agent/queue";
import { Portal } from "@/components/ui/portal";

const SOURCE: Record<string, string> = {
  meta_ads: "Meta Ads", web_form: "Website", indiamart: "IndiaMART", justdial: "Justdial", inbound_call: "Inbound call",
  csv: "CSV import", google_ads: "Google Ads", sheet: "Google Sheet", api: "API", manual: "Manual",
};

type Phase = "idle" | "agent_ringing" | "customer_ringing" | "connected" | "ended";
const TERMINAL = new Set(["completed", "missed", "agent_no_answer", "busy", "no_answer", "failed", "unknown"]);

function phaseOf(status: string): Phase {
  if (status === "initiated" || status === "agent_ringing") return "agent_ringing";
  if (status === "customer_ringing" || status === "ringing") return "customer_ringing";
  if (status === "answered") return "connected";
  return TERMINAL.has(status) ? "ended" : "idle";
}

function ago(min: number) {
  const m = Math.abs(min);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

function agoIso(iso: string, now: number) {
  return ago(Math.round((now - new Date(iso).getTime()) / 60000));
}

const CAT_ON: Record<string, string> = {
  positive: "data-[on=true]:bg-teal data-[on=true]:text-ink data-[on=true]:ring-teal",
  converted: "data-[on=true]:bg-moss data-[on=true]:text-sheet data-[on=true]:ring-moss",
  callback: "data-[on=true]:bg-amber data-[on=true]:text-sheet data-[on=true]:ring-amber",
  neutral: "data-[on=true]:bg-ink data-[on=true]:text-sheet data-[on=true]:ring-ink",
  negative: "data-[on=true]:bg-ink-2 data-[on=true]:text-sheet data-[on=true]:ring-ink-2",
  dnc: "data-[on=true]:bg-ember data-[on=true]:text-sheet data-[on=true]:ring-ember",
};

/** Callback quick picks in the agent's local time (crmv7 default 11:45 AM). */
function quickPicks(): { label: string; at: Date }[] {
  const now = new Date();
  const at = (days: number, h: number, m: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const sixPm = at(0, 18, 0);
  return [
    { label: "In 1 hour", at: new Date(now.getTime() + 3600_000) },
    sixPm > now ? { label: "Today 6:00 PM", at: sixPm } : { label: "Tomorrow 6:00 PM", at: at(1, 18, 0) },
    { label: "Tomorrow 11:45 AM", at: at(1, 11, 45) },
    { label: "In 2 days 11:45 AM", at: at(2, 11, 45) },
  ];
}

export function LiveConsole({
  initialQueue,
  initialLead,
  processes,
  options,
  showOwners,
  canEdit,
  canReassign,
  dial,
}: {
  initialQueue: QueueItem[];
  initialLead: LeadDetail | null;
  processes: { id: string; name: string }[];
  /** Same filter choices as the Leads screen (stages, sources, owners, campaigns, outcomes, custom fields). */
  options: FilterOptions;
  showOwners: boolean;
  canEdit: boolean;
  canReassign: boolean;
  /** From a Leads-row call icon: call this number of `initialLead` once. */
  dial?: "primary" | "alt";
}) {
  const [queue, setQueue] = useState(initialQueue);
  const [filter, setFilter] = useState<"all" | "due" | "new">("all");
  const [q, setQ] = useState("");
  // Same filters as the Leads screen, applied IN SQL (queueAction → leadFilterWhere).
  // The pop-up edits a draft; Apply sends it and closes. Text search + tabs stay instant.
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const filtersRef = useRef<Record<string, string>>({});
  const [queueOpen, setQueueOpen] = useState(false); // small screens only
  const [lead, setLead] = useState<LeadDetail | null>(initialLead);
  const [phase, setPhase] = useState<Phase>("idle");
  const [callId, setCallId] = useState<string | null>(null);
  const [dialled, setDialled] = useState<"primary" | "alt">("primary");
  const [talk, setTalk] = useState(0);
  const [endReason, setEndReason] = useState<string | null>(null);
  const [noCall, setNoCall] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [when, setWhen] = useState<Date | null>(null);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const connectedAt = useRef<number | null>(null);
  // "Now" for relative times; ticks every 30 s (render stays pure).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, "");
    return queue.filter(
      (l) =>
        (filter === "due" ? (l.callbackInMin !== null && l.callbackInMin <= 0) || l.missedCall : filter === "new" ? l.attempts === 0 : true) &&
        (!needle ||
          l.name.toLowerCase().includes(needle) ||
          (l.city ?? "").toLowerCase().includes(needle) ||
          (l.lastDisposition ?? "").toLowerCase().includes(needle) ||
          (digits.length >= 3 && l.phone.replace(/\D/g, "").includes(digits))),
    );
  }, [queue, filter, q]);
  const applied = appliedChips(filters, options).length;
  const narrowed = !!(q || applied || filters.process);
  /** Merge a patch (empty value = remove), refetch the queue with it. */
  function applyFilters(patch: Record<string, string>, replace = false) {
    const next = Object.fromEntries(Object.entries(replace ? patch : { ...filtersRef.current, ...patch }).filter(([, v]) => v));
    filtersRef.current = next;
    setFilters(next);
    startTransition(async () => {
      const r = await queueAction(next);
      if (r.ok) setQueue(r.data);
      else setError(r.error);
    });
  }
  const pos = lead ? visible.findIndex((l) => l.id === lead.id) : -1;
  const counts = {
    all: queue.length,
    due: queue.filter((l) => (l.callbackInMin !== null && l.callbackInMin <= 0) || l.missedCall).length,
    new: queue.filter((l) => l.attempts === 0).length,
  };

  const resetWorkspace = () => {
    setPhase("idle");
    setCallId(null);
    setTalk(0);
    setEndReason(null);
    setNoCall(false);
    setPicked(null);
    setWhen(null);
    setNote("");
    setSaved(null);
    setError(null);
    connectedAt.current = null;
  };

  // Fast clicking through leads: only the LAST requested lead is shown.
  const wantedLead = useRef<string | null>(null);
  const open = useCallback((id: string) => {
    wantedLead.current = id;
    startTransition(async () => {
      const r = await leadAction(id);
      if (wantedLead.current !== id) return;
      if (r.ok) {
        setLead(r.data);
        resetWorkspace();
      } else setError(r.error);
    });
  }, []);

  const refreshQueue = useCallback(async () => {
    const r = await queueAction(filtersRef.current);
    if (r.ok) setQueue(r.data);
  }, []);

  // Poll call status during a call; poll queue + screen-pop otherwise.
  // Scale (500+ agents): the next poll is scheduled only after the previous one
  // finishes (no pile-up when the server is slow), an idle console doesn't poll
  // while its tab is hidden (it refreshes the moment it's shown again), and a
  // live call is checked every 1.5 s (10 s when hidden) — call webhooks are
  // applied the moment they arrive (lib/webhooks/receive.ts processNow).
  useEffect(() => {
    const live = phase === "agent_ringing" || phase === "customer_ringing" || phase === "connected";
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (live) {
        const r = await callStatusAction(callId ?? undefined);
        if (r.ok && r.data) {
          const p = phaseOf(r.data.status);
          if (p === "connected" && connectedAt.current === null) connectedAt.current = Date.now();
          if (p === "ended") {
            setEndReason(r.data.status === "completed" ? null : r.data.status.replace(/_/g, " "));
            if (r.data.durationSec) setTalk(r.data.durationSec);
            void refreshQueue();
          }
          setPhase(p);
        }
      } else {
        await refreshQueue();
        const r = await callStatusAction();
        if (r.ok && r.data && r.data.leadId && r.data.direction === "inbound" && r.data.id !== callId) {
          // Inbound call answered on my phone → open that lead (screen-pop).
          const d = await leadAction(r.data.leadId);
          if (d.ok) {
            setLead(d.data);
            resetWorkspace();
            setCallId(r.data.id);
            setPhase(phaseOf(r.data.status));
          }
        }
      }
    };
    const schedule = () => {
      if (stopped) return;
      const hidden = document.visibilityState === "hidden";
      if (hidden && !live) return; // resumed by onVisible
      timer = setTimeout(async () => {
        try {
          await poll();
        } catch {
          // Network blip: try again on the next round.
        }
        schedule();
      }, live ? (hidden ? 10_000 : 1_500) : 20_000);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible" || live) return;
      clearTimeout(timer);
      void poll().catch(() => undefined).finally(schedule);
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [phase, callId, refreshQueue]);

  // Talk timer.
  useEffect(() => {
    if (phase !== "connected") return;
    const t = setInterval(() => setTalk(Math.round((Date.now() - (connectedAt.current ?? Date.now())) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  function call(number: "primary" | "alt" = "primary") {
    if (!lead || phase !== "idle" || lead.dnc || lead.status !== "open") return;
    if (number === "alt" && !lead.altPhone) return;
    setError(null);
    setDialled(number);
    startTransition(async () => {
      const r = await startCallAction(lead.id, number);
      if (r.ok) {
        setCallId(r.data.interactionId);
        setPhase("agent_ringing");
      } else setError(r.error);
    });
  }

  // Arrived from a Leads-row call icon: place that call once, then drop `dial`
  // from the URL so a refresh doesn't ring again.
  const dialDone = useRef(false);
  useEffect(() => {
    if (dialDone.current || !dial) return;
    dialDone.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("dial");
    window.history.replaceState(null, "", url);
    call(dial);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  const outcome = lead?.outcomes.find((o) => o.id === picked) ?? null;
  // Outcome, note and callback can be filled (and saved) during the call too —
  // the outcome lands on this call's interaction either way (lib/agent/outcome.ts).
  const canRecord = !!lead && lead.status === "open" && (phase !== "idle" || noCall) && !saved;
  const canSave = canRecord && !!outcome && (outcome.category !== "callback" || !!when);

  function save() {
    if (!lead || !outcome || !canSave) return;
    startTransition(async () => {
      const r = await saveOutcomeAction({ leadId: lead.id, dispositionId: outcome.id, note, callbackAt: when?.toISOString() });
      if (r.ok) {
        setSaved(when ? `${outcome.label} · ${when.toLocaleString("en-IN", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : outcome.label);
        setError(null);
        void refreshQueue();
        if (r.data) setLead(r.data);
      } else setError(r.error);
    });
  }

  // Keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).closest("input,textarea,select") || e.metaKey || e.ctrlKey) return;
      const i = visible.findIndex((l) => l.id === lead?.id);
      if (e.key === "j" && i < visible.length - 1) open(visible[i + 1]!.id);
      if (e.key === "k" && i > 0) open(visible[i - 1]!.id);
      if (e.key.toLowerCase() === "c") call(e.shiftKey ? "alt" : "primary");
      if (canRecord && /^[1-9]$/.test(e.key)) {
        const o = lead?.outcomes[Number(e.key) - 1];
        if (o) setPicked(o.id);
      }
      if (e.key === "Enter") save();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const mmss = `${String(Math.floor(talk / 60)).padStart(2, "0")}:${String(talk % 60).padStart(2, "0")}`;
  const steps: { p: Exclude<Phase, "idle">; label: string }[] = [
    { p: "agent_ringing", label: "Your phone" },
    { p: "customer_ringing", label: "Customer" },
    { p: "connected", label: "Connected" },
    { p: "ended", label: "Ended" },
  ];
  const stepIndex = steps.findIndex((s) => s.p === phase);

  return (
    // Responsive: queue + lead on tablets/laptops; queue + lead + timeline on wide screens;
    // below md the queue becomes a slide-over opened from the lead header.
    <div className="relative grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[270px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_320px] 2xl:grid-cols-[340px_minmax(0,1fr)_360px]">
      {/* Queue */}
      <aside className={`${queueOpen ? "absolute inset-y-0 left-0 z-30 flex w-[300px] shadow-[8px_0_30px_-12px_rgba(21,23,28,0.35)]" : "hidden"} min-h-0 flex-col border-r border-rule bg-sheet md:static md:flex md:w-auto md:shadow-none`}>
        <div className="flex items-center gap-1 border-b border-rule p-2">
          {(["all", "due", "new"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[5px] text-[12.5px] font-medium transition ${filter === f ? "bg-ink text-sheet" : "text-ink-3 hover:bg-paper hover:text-ink"}`}
            >
              {f === "all" ? "My queue" : f === "due" ? "Due now" : "New"}
              <span className={`font-mono text-[11px] ${filter === f ? "text-teal" : f === "due" ? "text-ember" : "text-ink-4"}`}>{counts[f]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 border-b border-rule p-2">
          <label className="flex h-8 items-center gap-2 rounded-md border border-rule bg-paper/60 px-2.5 focus-within:border-ink">
            <Search size={13} className="text-ink-4" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter: name, city, phone digits, outcome" className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-ink-4" aria-label="Filter queue" />
            {q && <button onClick={() => setQ("")} aria-label="Clear filter"><X size={12} className="text-ink-3" /></button>}
          </label>
          <div className="flex gap-1.5">
            <ProcessPicker className="min-w-0 flex-1" processes={processes} value={filters.process ? filters.process.split(",") : []} onChange={(ids) => applyFilters({ process: ids.join(",") })} />
            <button
              onClick={() => setDraft({ ...filters })}
              aria-haspopup="dialog"
              className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-md border px-2.5 text-[12px] font-medium ${applied ? "border-ink bg-ink text-sheet" : "border-rule bg-sheet text-ink-3 hover:text-ink"}`}
            >
              <Filter size={13} /> Filters{applied ? ` · ${applied}` : ""}
            </button>
          </div>
          {/* Applied filters stay visible on the page after the pop-up closes. */}
          <AppliedFilters params={filters} options={options} onChange={(patch) => applyFilters(patch)} />
          {narrowed && (
            <div className="flex items-center justify-between px-0.5 text-[11.5px] text-ink-3">
              <span>{visible.length} of {queue.length} leads match</span>
              {(q || filters.process) && !applied && (
                <button onClick={() => (setQ(""), applyFilters({}, true))} className="font-medium text-teal-ink hover:underline">
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {visible.map((l) => {
            const overdue = l.callbackInMin !== null && l.callbackInMin <= 0;
            const fraction = overdue ? 1 : l.callbackInMin !== null ? 1 - l.callbackInMin / 240 : Math.min(l.ageMin / 30, 1);
            const active = l.id === lead?.id;
            return (
              <li key={l.id}>
                <button onClick={() => (open(l.id), setQueueOpen(false))} className={`relative flex w-full items-center gap-3 border-b border-rule px-3 py-3 text-left transition ${active ? "bg-paper" : "hover:bg-paper/60"}`}>
                  {active && <span className="absolute inset-y-0 left-0 w-[3px] bg-ink" />}
                  <SlaRing fraction={fraction} overdue={overdue} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold">{l.name}</span>
                      {l.missedCall && <PhoneMissed size={13} className="shrink-0 text-ember" aria-label="Missed call" />}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">{SOURCE[l.source] ?? l.source}{l.city ? ` · ${l.city}` : ""}</span>
                  </span>
                  <span className="text-right">
                    <span className={`block font-mono text-[11.5px] tnum ${overdue ? "font-semibold text-ember-ink" : "text-ink-3"}`}>
                      {overdue ? `-${ago(l.callbackInMin!)}` : l.callbackInMin !== null ? `in ${ago(l.callbackInMin)}` : ago(l.ageMin)}
                    </span>
                    <span className="mt-1 block"><StageTag stage={l.stage} /></span>
                  </span>
                </button>
              </li>
            );
          })}
          {visible.length === 0 && (
            <li className="px-4 py-10 text-center text-[13px] text-ink-3">
              {queue.length === 0 ? "Your queue is empty. New leads appear here as they arrive." : "Nothing in this filter."}
            </li>
          )}
        </ul>
        <div className="flex items-center gap-3 border-t border-rule px-3 py-2 text-[11px] text-ink-3">
          <span className="inline-flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
          <span className="inline-flex items-center gap-1"><Kbd>C</Kbd> call</span>
          <span className="inline-flex items-center gap-1"><Kbd>1</Kbd>–<Kbd>9</Kbd> outcome</span>
        </div>
      </aside>

      {/* Lead */}
      <main className="min-h-0 overflow-y-auto px-4 py-5 md:px-6 xl:px-8 xl:py-7">
        {!lead ? (
          <div className="dotgrid flex h-full items-center justify-center rounded-md">
            <p className="panel px-5 py-4 text-[13px] text-ink-3">Pick a lead from your queue.</p>
          </div>
        ) : (
          <div className={`mx-auto flex max-w-[760px] flex-col gap-5 transition-opacity ${busy && !saved ? "opacity-80" : ""}`}>
            <header>
              <div className="mb-2 flex items-center justify-between gap-3 text-[12px] text-ink-3">
                <span className="flex min-w-0 items-center gap-2">
                  <button onClick={() => setQueueOpen(true)} className="h-7 shrink-0 rounded border border-rule bg-sheet px-2 text-[12px] font-medium text-ink-2 md:hidden">Queue · {visible.length}</button>
                  <span className="truncate">{lead.processName}{lead.owner ? ` · owner ${lead.owner}` : ""}</span>
                </span>
                {visible.length > 0 && (
                  <span className="flex shrink-0 items-center gap-1">
                    <button onClick={() => pos > 0 && open(visible[pos - 1]!.id)} disabled={pos <= 0} aria-label="Previous lead" title="Previous lead (K)" className="inline-flex h-7 w-7 items-center justify-center rounded border border-rule bg-sheet text-ink-2 hover:border-ink-3 disabled:opacity-35">
                      <ChevronLeft size={14} />
                    </button>
                    <span className="min-w-[64px] text-center font-mono tnum">{pos >= 0 ? `${pos + 1} of ${visible.length}` : `– of ${visible.length}`}</span>
                    <button onClick={() => open(visible[pos + 1]?.id ?? visible[0]!.id)} disabled={pos >= visible.length - 1} aria-label="Next lead" title="Next lead (J)" className="inline-flex h-7 w-7 items-center justify-center rounded border border-rule bg-sheet text-ink-2 hover:border-ink-3 disabled:opacity-35">
                      <ChevronRight size={14} />
                    </button>
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="text-[30px] font-semibold leading-none tracking-[-0.02em]">{lead.name}</h2>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
                    <span className="font-mono text-[18px] font-medium tracking-tight text-ink tnum">{lead.phone}</span>
                    {lead.altPhone && (
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="text-[11px] text-ink-4">Mobile 2</span>
                        <span className="font-mono text-[15px] font-medium tracking-tight text-ink-2 tnum">{lead.altPhone}</span>
                      </span>
                    )}
                    {lead.email && <span className="inline-flex items-center gap-1"><AtSign size={13} className="text-ink-4" />{lead.email}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Tag>{SOURCE[lead.source] ?? lead.source}</Tag>
                  {lead.attempts > 0 && <Tag><Repeat2 size={11} />{lead.attempts} attempt{lead.attempts > 1 ? "s" : ""}</Tag>}
                  {lead.status !== "open" && <Tag tone={lead.status === "won" ? "moss" : "ember"}>{lead.status}</Tag>}
                </div>
              </div>
            </header>

            {/* Stage picker */}
            <div className="flex flex-wrap items-center gap-1.5">
              {lead.stages.map((st) => (
                <button
                  key={st}
                  disabled={lead.status !== "open" || busy}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await setStageAction({ leadId: lead.id, stage: st });
                      if (r.ok) {
                        if (r.data) setLead(r.data);
                        void refreshQueue();
                      } else setError(r.error);
                    })
                  }
                  className={`h-7 rounded-[4px] px-2.5 text-[12px] font-medium ring-1 ring-inset transition disabled:cursor-not-allowed ${
                    lead.stage === st ? "bg-ink text-sheet ring-ink" : "text-ink-3 ring-rule hover:ring-ink-3"
                  } ${st === lead.wonStage && lead.stage !== st ? "ring-moss/50 text-moss" : ""}`}
                >
                  {st}
                </button>
              ))}
              <span className="ml-1 text-[11px] text-ink-4">“{lead.wonStage}” converts the lead</span>
            </div>

            {lead.nextCallbackAt && new Date(lead.nextCallbackAt).getTime() <= now && lead.status === "open" && (
              <div className="rounded-md border-l-[3px] border-ember bg-ember-wash px-4 py-2.5 text-[13px] font-semibold text-ember-ink">
                Callback overdue by {agoIso(lead.nextCallbackAt, now)}{lead.lastDisposition ? ` · last outcome: ${lead.lastDisposition}` : ""}
              </div>
            )}
            {saved && (
              <div className="flex items-center gap-2 rounded-md border-l-[3px] border-moss bg-moss-wash px-4 py-2.5 text-[13px] text-moss">
                <Check size={15} /> Saved: <span className="font-semibold">{saved}</span> — press <Kbd>J</Kbd> for the next lead.
              </div>
            )}
            <ErrorNote message={error} />
            {error?.includes("already on a call") && (
              <div className="-mt-3 flex items-center gap-3 text-[12.5px] text-ink-3">
                <span>Call never reached the customer or the provider didn’t report back?</span>
                <button
                  onClick={() =>
                    startTransition(async () => {
                      const r = await endStuckCallAction();
                      if (!r.ok) return setError(r.error);
                      resetWorkspace();
                      if (lead) {
                        const d = await leadAction(lead.id);
                        if (d.ok) setLead(d.data);
                      }
                    })
                  }
                  className="h-8 rounded-md border border-ember/50 bg-sheet px-3 font-semibold text-ember-ink hover:bg-ember/10"
                >
                  End that call
                </button>
              </div>
            )}

            {/* Click-to-call */}
            <div className="panel overflow-hidden">
              <div className="flex items-center gap-4 p-4">
                {phase === "idle" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => call("primary")}
                      disabled={lead.dnc || lead.status !== "open" || busy}
                      title={lead.altPhone ? `Call ${lead.phone}` : undefined}
                      className="group inline-flex h-12 items-center gap-3 rounded-md bg-ink pl-4 pr-3 text-sheet transition hover:bg-ink-2 disabled:cursor-not-allowed disabled:bg-ink-4"
                    >
                      <Phone size={18} className="text-teal" />
                      <span className="text-[15px] font-semibold">{lead.dnc ? "Do not call" : lead.altPhone ? "Call Mobile 1" : "Call"}</span>
                      {!lead.dnc && <span className="ml-1 rounded-[3px] bg-white/10 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-4">C</span>}
                    </button>
                    {lead.altPhone && !lead.dnc && (
                      <button
                        onClick={() => call("alt")}
                        disabled={lead.status !== "open" || busy}
                        title={`Call ${lead.altPhone}`}
                        className="inline-flex h-12 items-center gap-3 rounded-md border border-ink bg-sheet pl-4 pr-3 text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Phone size={18} className="text-teal-ink" />
                        <span className="text-[15px] font-semibold">Call Mobile 2</span>
                        <span className="ml-1 rounded-[3px] bg-ink/5 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3">⇧C</span>
                      </button>
                    )}
                  </div>
                ) : phase === "connected" ? (
                  <div className="flex h-12 items-center gap-3 rounded-md bg-teal-wash px-4 text-teal-ink">
                    <span className="live-dot h-2.5 w-2.5 rounded-full bg-teal text-teal" />
                    <span className="font-mono text-[22px] font-semibold tnum">{mmss}</span>
                  </div>
                ) : phase === "ended" ? (
                  <div className="flex h-12 items-center gap-2 rounded-md bg-paper px-4 text-ink-2 ring-1 ring-inset ring-rule">
                    <PhoneOff size={17} />
                    <span className="text-[13px]">{endReason ? `Call ended · ${endReason}` : `Call ended · ${mmss} talk`} — set the outcome below</span>
                  </div>
                ) : (
                  <div className="flex h-12 items-center gap-3 rounded-md bg-ember-wash px-4 text-ember-ink">
                    {phase === "agent_ringing" ? <Smartphone size={18} /> : <PhoneIncoming size={18} />}
                    <span className="text-[14px] font-semibold">{phase === "agent_ringing" ? "Pick up your phone…" : lead.altPhone ? `Ringing ${dialled === "alt" ? "Mobile 2" : "Mobile 1"}…` : "Ringing the customer…"}</span>
                  </div>
                )}
                <div className="ml-auto text-right text-[11.5px] leading-tight text-ink-3">
                  <div>Click-to-call · no SIP</div>
                  <div>Rings your registered phone first</div>
                </div>
              </div>
              <ol className="grid grid-cols-4 border-t border-rule">
                {steps.map((s, i) => {
                  const done = stepIndex > i || phase === "ended";
                  const current = stepIndex === i && phase !== "ended";
                  return (
                    <li key={s.p} className="relative border-r border-rule px-4 py-2.5 last:border-r-0">
                      <span className={`absolute inset-x-0 top-0 h-[3px] ${done ? "bg-ink" : current ? (s.p === "connected" ? "bg-teal" : "bg-ember") : "bg-transparent"}`} />
                      <div className={`text-[11px] font-semibold ${done || current ? "text-ink" : "text-ink-4"}`}>
                        <span className="font-mono">{String(i + 1).padStart(2, "0")}</span> {s.label}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>

            {/* Outcome */}
            <section className={`panel p-4 transition-opacity ${canRecord || saved ? "" : "opacity-60"}`}>
              <div className="mb-3 flex items-baseline justify-between">
                <div className="eyebrow">Outcome</div>
                {phase === "idle" && !noCall && lead.status === "open" ? (
                  <button onClick={() => setNoCall(true)} className="text-[11.5px] text-ink-3 underline-offset-2 hover:text-ink hover:underline">
                    Record without a call
                  </button>
                ) : (
                  <span className="text-[11.5px] text-ink-3">{canRecord ? "Press 1–9, then Enter" : lead.status !== "open" ? "Lead is closed" : "Unlocks when you call"}</span>
                )}
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {lead.outcomes.map((o, i) => (
                  <button
                    key={o.id}
                    disabled={!canRecord}
                    data-on={picked === o.id}
                    onClick={() => setPicked(o.id)}
                    className={`flex h-10 items-center justify-between rounded-[5px] px-2.5 text-left text-[12.5px] font-medium text-ink-2 ring-1 ring-inset ring-rule transition hover:ring-ink-3 disabled:cursor-not-allowed ${CAT_ON[o.category]}`}
                  >
                    <span className="truncate">{o.label}</span>
                    {i < 9 && <span className="font-mono text-[10.5px] opacity-60">{i + 1}</span>}
                  </button>
                ))}
              </div>
              {outcome?.category === "callback" && canRecord && (
                <div className="mt-3">
                  <div className="eyebrow mb-1.5">Call back</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {quickPicks().map((q) => (
                      <button
                        key={q.label}
                        onClick={() => setWhen(q.at)}
                        className={`h-8 rounded-[5px] px-2.5 text-[12px] ring-1 ring-inset transition ${when?.getTime() === q.at.getTime() ? "bg-amber text-sheet ring-amber" : "text-ink-2 ring-rule hover:ring-ink-3"}`}
                      >
                        {q.label}
                      </button>
                    ))}
                    <input
                      type="datetime-local"
                      aria-label="Custom callback time"
                      onChange={(e) => setWhen(e.target.value ? new Date(e.target.value) : null)}
                      className="h-8 rounded-[5px] border border-rule bg-sheet px-2 text-[12px]"
                    />
                  </div>
                </div>
              )}
              <div className="mt-3 flex items-end gap-2">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={!canRecord}
                  placeholder="Note for the next call (optional)"
                  rows={2}
                  className="min-h-[44px] flex-1 resize-none rounded-[5px] border border-rule bg-sheet px-3 py-2 text-[13px] outline-none placeholder:text-ink-4 focus:border-ink disabled:bg-paper"
                />
                <button
                  onClick={save}
                  disabled={!canSave || busy}
                  className="inline-flex h-[44px] items-center gap-2 rounded-[5px] bg-ink px-4 text-[13px] font-semibold text-sheet transition hover:bg-ink-2 disabled:cursor-not-allowed disabled:bg-rule-strong disabled:text-ink-3"
                >
                  {saved ? <Check size={16} /> : <CornerDownLeft size={15} />}
                  {saved ? "Saved" : busy && picked ? "Saving…" : "Save"}
                </button>
              </div>
            </section>

            {/* Order: call → outcome → details (owner's choice). Details stay editable before, during and after a call. */}
            <LeadDetails key={lead.id} lead={lead} canEdit={canEdit} canReassign={canReassign} onSaved={(d) => (setLead(d), void refreshQueue())} onError={setError} />

            <section className="panel p-4 xl:hidden">
              <div className="eyebrow mb-3">Timeline</div>
              <LeadTimeline key={lead.id} items={lead.timeline} now={now} />
            </section>
          </div>
        )}
      </main>

      {/* Filter pop-up: edit a draft, Apply sends it and closes (console has little room for a rail). */}
      {draft && (
        <Portal>
        <div className="fixed inset-0 z-50 bg-ink/25" onMouseDown={(e) => e.target === e.currentTarget && setDraft(null)}>
          <div role="dialog" aria-label="Filter the queue" className="absolute top-3 bottom-3 left-[84px] flex w-[320px] max-w-[calc(100vw-96px)] flex-col overflow-hidden rounded-lg border border-rule bg-sheet shadow-[0_24px_60px_-20px_rgba(21,23,28,0.45)]">
            <div className="flex shrink-0 items-center justify-between border-b border-rule px-4 py-3">
              <span className="text-[14px] font-semibold">Filter the queue</span>
              <button onClick={() => setDraft(null)} aria-label="Close" className="rounded p-1 text-ink-3 hover:bg-paper hover:text-ink"><X size={15} /></button>
            </div>
            <FilterPanel
              variant="popover"
              className="flex min-h-0 flex-1 rounded-none border-0"
              params={draft}
              options={options}
              showOwners={showOwners}
              onChange={(patch) => setDraft((d) => Object.fromEntries(Object.entries({ ...d, ...patch }).filter(([, v]) => v)))}
            />
            <div className="flex shrink-0 items-center gap-2 border-t border-rule px-4 py-3">
              <button onClick={() => (applyFilters(draft, true), setDraft(null))} className="h-9 flex-1 rounded-md bg-ink text-[13px] font-semibold text-sheet hover:bg-ink-2">
                Apply
              </button>
              <button onClick={() => setDraft(filters.process ? { process: filters.process } : {})} className="h-9 rounded-md border border-rule px-3 text-[13px] font-medium text-ink-2 hover:border-ink-3">
                Reset
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Timeline — right column on wide screens (xl+); inside the lead column below that */}
      <aside className="hidden min-h-0 overflow-y-auto border-l border-rule bg-sheet px-5 py-6 xl:block">
        <div className="eyebrow mb-3">Timeline</div>
        {lead ? <LeadTimeline key={lead.id} items={lead.timeline} now={now} /> : <p className="text-[12.5px] text-ink-4">—</p>}
      </aside>
    </div>
  );
}
