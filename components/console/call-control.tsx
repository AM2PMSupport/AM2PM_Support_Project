"use client";

/**
 * Click-to-call control — mirrors the real flow (ARCHITECTURE.md §3.3):
 * the provider rings the AGENT'S phone first, then the customer, then
 * bridges. There is no audio in the browser and no hang-up button: the call
 * lives on the agent's phone (no SIP). The stepper shows where the call is;
 * in production each step is driven by provider webhooks over SSE (T1.40).
 * In preview the steps are simulated on a timer.
 */
import { useEffect, useRef, useState } from "react";
import { Phone, PhoneIncoming, PhoneOff, Smartphone } from "lucide-react";
import { Kbd } from "@/components/ui/primitives";

export type CallPhase = "idle" | "agent_ringing" | "customer_ringing" | "connected" | "ended";

const STEPS: { phase: Exclude<CallPhase, "idle">; label: string }[] = [
  { phase: "agent_ringing", label: "Your phone" },
  { phase: "customer_ringing", label: "Customer" },
  { phase: "connected", label: "Connected" },
  { phase: "ended", label: "Ended" },
];

function mmss(sec: number) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

export function CallControl({
  did,
  dnc,
  onPhaseChange,
}: {
  did: string;
  dnc?: boolean;
  onPhaseChange?: (p: CallPhase) => void;
}) {
  // The parent remounts this control per lead (key={lead.id}), which resets it.
  const [phase, setPhaseState] = useState<CallPhase>("idle");
  const [talk, setTalk] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  function setPhase(p: CallPhase) {
    setPhaseState(p);
    onPhaseChange?.(p);
  }

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    if (phase !== "connected") return;
    const t = setInterval(() => setTalk((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  function start() {
    if (phase !== "idle" || dnc) return;
    setPhase("agent_ringing");
    timers.current = [
      setTimeout(() => setPhase("customer_ringing"), 1600),
      setTimeout(() => setPhase("connected"), 3600),
    ];
  }

  // Keyboard: C to call (when focus is not in a text field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (el.closest("input,textarea,select")) return;
      if (e.metaKey || e.ctrlKey) return;
      if (e.key.toLowerCase() === "c") start();
      if (e.key.toLowerCase() === "e" && phase === "connected") setPhase("ended");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const activeIndex = STEPS.findIndex((s) => s.phase === phase);

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-4 p-4">
        {phase === "idle" ? (
          <button
            onClick={start}
            disabled={dnc}
            className="group inline-flex h-12 items-center gap-3 rounded-md bg-ink pl-4 pr-3 text-sheet transition hover:bg-ink-2 disabled:cursor-not-allowed disabled:bg-ink-4"
          >
            <Phone size={18} strokeWidth={2} className="text-teal" />
            <span className="text-[15px] font-semibold">{dnc ? "Do not call" : "Call"}</span>
            {!dnc && (
              <span className="ml-1 rounded-[3px] bg-white/10 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-4 group-hover:text-sheet">C</span>
            )}
          </button>
        ) : phase === "connected" ? (
          <div className="flex h-12 items-center gap-3 rounded-md bg-teal-wash px-4 text-teal-ink">
            <span className="live-dot h-2.5 w-2.5 rounded-full bg-teal text-teal" />
            <span className="font-mono text-[22px] font-semibold tnum">{mmss(talk)}</span>
          </div>
        ) : phase === "ended" ? (
          <div className="flex h-12 items-center gap-2 rounded-md bg-paper px-4 text-ink-2 ring-1 ring-inset ring-rule">
            <PhoneOff size={17} />
            <span className="font-mono text-[15px] tnum">{mmss(talk)}</span>
            <span className="text-[13px]">talk time · set the outcome below</span>
          </div>
        ) : (
          <div className="flex h-12 items-center gap-3 rounded-md bg-ember-wash px-4 text-ember-ink">
            {phase === "agent_ringing" ? <Smartphone size={18} /> : <PhoneIncoming size={18} />}
            <span className="text-[14px] font-semibold">
              {phase === "agent_ringing" ? "Pick up your phone…" : "Ringing the customer…"}
            </span>
          </div>
        )}

        <div className="ml-auto text-right text-[11.5px] leading-tight text-ink-3">
          <div>
            Caller ID <span className="font-mono text-ink-2">{did}</span>
          </div>
          <div>Rings your registered phone first</div>
        </div>
      </div>

      {/* Stepper */}
      <ol className="grid grid-cols-4 border-t border-rule">
        {STEPS.map((s, i) => {
          const done = activeIndex > i || phase === "ended";
          const current = activeIndex === i && phase !== "ended";
          return (
            <li key={s.phase} className="relative border-r border-rule px-4 py-2.5 last:border-r-0">
              <span
                className={`absolute inset-x-0 top-0 h-[3px] ${done ? "bg-ink" : current ? (s.phase === "connected" ? "bg-teal" : "bg-ember") : "bg-transparent"}`}
              />
              <div className={`text-[11px] font-semibold ${done || current ? "text-ink" : "text-ink-4"}`}>
                <span className="font-mono">{String(i + 1).padStart(2, "0")}</span> {s.label}
              </div>
            </li>
          );
        })}
      </ol>

      {phase === "connected" && (
        <div className="flex items-center justify-between border-t border-rule bg-sheet px-4 py-2 text-[12px] text-ink-3">
          <span>End the call on your phone — the CRM updates when the provider reports it.</span>
          <button onClick={() => setPhase("ended")} className="inline-flex items-center gap-1.5 text-ink-2 underline-offset-2 hover:underline">
            Simulate end <Kbd>E</Kbd>
          </button>
        </div>
      )}
    </div>
  );
}
