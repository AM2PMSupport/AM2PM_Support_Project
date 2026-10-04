"use client";

/**
 * The login poster's brand clock, as a working watch: the logo's teal and
 * orange arcs are the bezel and hour, minute and second hands show live IST.
 *
 * Accuracy:
 *  - Angles come from the clock every animation frame (lib/time/clock.ts),
 *    not from counting ticks, so a throttled background tab is right again
 *    as soon as it's visible.
 *  - The device clock is corrected against GET /api/time once on mount
 *    (agents' PCs drift; a CRM about callback times shouldn't show the wrong time).
 *  - Hands stay hidden until the first client frame. The server can't know the
 *    viewer's "now", and rendering one would cause a hydration mismatch.
 * Hands are moved by writing `transform` on refs, not React state, so there is
 * no re-render at 60 fps. Reduced motion → the second hand ticks once a second.
 */
import { useEffect, useRef } from "react";
import { clockOffset, handAngles, IST_OFFSET_MS } from "@/lib/time/clock";

const C = 200; // dial centre in the 400×400 viewBox
// Rounded so server (Node) and browser trig agree to the digit — else hydration mismatch.
const r2 = (n: number) => Math.round(n * 100) / 100;

const readout = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
const dateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });

export function BrandWatch() {
  const hourRef = useRef<SVGGElement>(null);
  const minuteRef = useRef<SVGGElement>(null);
  const secondRef = useRef<SVGGElement>(null);
  const handsRef = useRef<SVGGElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const dateRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let offset = 0;
    let raf = 0;
    let lastSecond = -1;
    let stopped = false;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    const sentAt = Date.now();
    fetch("/api/time", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ now?: number }>) : null))
      .then((b) => {
        if (b && typeof b.now === "number") offset = clockOffset(b.now, sentAt, Date.now());
      })
      .catch(() => {}); // offline → device clock

    const frame = () => {
      if (stopped) return;
      const now = Date.now() + offset;
      const a = handAngles(now, IST_OFFSET_MS, !reduce.matches);
      hourRef.current?.setAttribute("transform", `rotate(${a.hour} ${C} ${C})`);
      minuteRef.current?.setAttribute("transform", `rotate(${a.minute} ${C} ${C})`);
      secondRef.current?.setAttribute("transform", `rotate(${a.second} ${C} ${C})`);
      handsRef.current?.setAttribute("opacity", "1");
      const sec = Math.floor(now / 1000);
      if (sec !== lastSecond) {
        lastSecond = sec;
        if (timeRef.current) timeRef.current.textContent = readout.format(now).toUpperCase();
        if (dateRef.current) dateRef.current.textContent = `IST · ${dateFmt.format(now)}`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-5">
      <svg viewBox="0 0 400 400" className="h-auto w-full" role="img" aria-label="Clock showing the current time in India">
        <circle cx={C} cy={C} r="168" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        {Array.from({ length: 60 }).map((_, i) => {
          const a = (i / 60) * Math.PI * 2;
          const long = i % 5 === 0;
          const r1 = long ? 182 : 188;
          return (
            <line
              key={i}
              x1={r2(C + Math.cos(a) * r1)}
              y1={r2(C + Math.sin(a) * r1)}
              x2={r2(C + Math.cos(a) * 194)}
              y2={r2(C + Math.sin(a) * 194)}
              stroke={long ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.16)"}
              strokeWidth={long ? 2.5 : 1}
            />
          );
        })}
        {/* the logo's bezel: teal outer arc, orange inner arc */}
        <path d="M315 85A160 160 0 1 0 360 200" stroke="#6BD3DC" strokeWidth="34" strokeLinecap="round" fill="none" />
        <path d="M286 114A120 120 0 0 1 240 313" stroke="#F56332" strokeWidth="18" strokeLinecap="round" fill="none" />
        {/* hour dots inside the arcs, so the hands read against a dial */}
        {Array.from({ length: 12 }).map((_, i) => {
          const a = (i / 12) * Math.PI * 2;
          return <circle key={i} cx={r2(C + Math.sin(a) * 100)} cy={r2(C - Math.cos(a) * 100)} r={i % 3 === 0 ? 4 : 2.2} fill="rgba(255,255,255,0.35)" />;
        })}

        <g ref={handsRef} opacity="0">
          <g ref={hourRef}>
            <line x1={C} y1={C + 14} x2={C} y2={C - 62} stroke="#6BD3DC" strokeWidth="14" strokeLinecap="round" />
          </g>
          <g ref={minuteRef}>
            <line x1={C} y1={C + 18} x2={C} y2={C - 92} stroke="#F5F3EE" strokeWidth="8" strokeLinecap="round" />
          </g>
          <g ref={secondRef}>
            <line x1={C} y1={C + 28} x2={C} y2={C - 104} stroke="#F56332" strokeWidth="3" strokeLinecap="round" />
            <circle cx={C} cy={C + 28} r="5" fill="#F56332" />
          </g>
          <circle cx={C} cy={C} r="10" fill="#F56332" />
          <circle cx={C} cy={C} r="3.5" fill="#15171C" />
        </g>
      </svg>
      <div className="flex items-baseline gap-3 whitespace-nowrap" aria-hidden="true">
        <span ref={timeRef} className="font-mono text-[22px] font-medium tracking-[0.02em] tnum text-sheet">
          --:--:--
        </span>
        <span ref={dateRef} className="text-[12px] text-ink-4" />
      </div>
    </div>
  );
}
