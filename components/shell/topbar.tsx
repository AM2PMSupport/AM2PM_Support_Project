"use client";

/**
 * Top bar: page title, global search, the live IST shift clock and the
 * sample-data marker. The clock is the brand motif made useful: agents work
 * shifts and callbacks are booked in IST.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Kbd } from "@/components/ui/primitives";
import { NotificationsBell } from "@/components/shell/notifications-bell";

function useIstClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // Rendered only on the client (null on the server) to avoid a hydration mismatch.
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  return now;
}

export function ShiftClock() {
  const now = useIstClock();
  const fmt = (o: Intl.DateTimeFormatOptions) => (now ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...o }).format(now) : "");
  return (
    <div className="flex items-baseline gap-2" aria-live="off">
      <span className="font-mono text-[15px] font-medium tnum text-ink">{now ? fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "--:--:--"}</span>
      <span className="text-[11px] text-ink-3">IST · {fmt({ weekday: "short", day: "numeric", month: "short" })}</span>
    </div>
  );
}

function TopSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  // "/" focuses search from anywhere (unless typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || (e.target as HTMLElement).closest("input,textarea,select")) return;
      e.preventDefault();
      (document.getElementById("leads-search") as HTMLInputElement | null)?.focus() ?? ref.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) router.push(`/leads?q=${encodeURIComponent(q.trim())}&status=all`);
      }}
      className="ml-auto flex h-9 w-full max-w-[380px] items-center gap-2 rounded-md border border-rule bg-sheet px-3 text-ink-3 focus-within:border-ink"
    >
      <Search size={15} strokeWidth={1.8} />
      <input
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Name, last 4 digits, or email"
        aria-label="Search leads"
        className="h-full flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
      />
      <Kbd>/</Kbd>
    </form>
  );
}

/** `search={false}` on screens that have their own search (Leads), so there is one box, not two. */
export function Topbar({ title, subtitle, sample = false, search = true }: { title: string; subtitle?: string; sample?: boolean; search?: boolean }) {
  return (
    <header className="sticky top-0 z-20 flex h-[60px] items-center gap-6 border-b border-rule bg-paper/95 px-6 backdrop-blur-[2px]">
      <div className="min-w-0">
        <h1 className="truncate text-[17px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="truncate text-[12px] text-ink-3">{subtitle}</p>}
      </div>

      {search ? <TopSearch /> : <div className="flex-1" />}

      <NotificationsBell />
      <ShiftClock />

      {sample && <span
        title="Screens show fictional sample data until sign-in (TASK.md T1.11) connects them to live data."
        className="hidden items-center gap-1.5 rounded-sm border border-dashed border-ember/60 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ember-ink lg:inline-flex"
      >
        Sample data
      </span>}
    </header>
  );
}
