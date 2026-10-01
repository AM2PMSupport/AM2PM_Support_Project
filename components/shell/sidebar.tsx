"use client";

/**
 * Left rail. Ink background so the paper workspace reads as the "desk".
 * Bottom: the agent's own status switch — the single most-used control in a
 * call center, so it lives here, always visible.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BarChart3, Headset, Settings2, UsersRound } from "lucide-react";
import { LogoMark } from "@/components/ui/logo";
import { ME, type AgentStatus } from "@/lib/ui/sample-data";
import { STATUS_META } from "@/lib/ui/status";

const NAV = [
  { href: "/console", label: "Console", icon: Headset },
  { href: "/leads", label: "Leads", icon: UsersRound },
  { href: "/dashboard", label: "Floor", icon: BarChart3 },
  { href: "/admin", label: "Setup", icon: Settings2 },
];


export function Sidebar() {
  const path = usePathname();
  const [status, setStatus] = useState<AgentStatus>("available");

  return (
    <aside className="sticky top-0 flex h-dvh w-[76px] shrink-0 flex-col items-center border-r border-black/40 bg-ink py-4 text-sheet">
      <Link href="/console" aria-label="AM2PM CRM home" className="mb-7">
        <LogoMark size={30} />
      </Link>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`group relative flex w-[60px] flex-col items-center gap-1 rounded-md py-2.5 text-[10.5px] font-medium transition-colors ${
                active ? "bg-white/[0.07] text-sheet" : "text-ink-4 hover:text-sheet"
              }`}
            >
              {active && <span className="absolute left-[-8px] top-2 bottom-2 w-[3px] rounded-r bg-teal" />}
              <Icon size={19} strokeWidth={1.7} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col items-center gap-3">
        <label className="group relative flex cursor-pointer flex-col items-center gap-1 text-[10px] text-ink-4">
          <span className="relative flex h-[34px] w-[34px] items-center justify-center rounded-full bg-white/10 text-[12px] font-semibold text-sheet">
            {ME.initials}
            <span className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-ink ${STATUS_META[status].dot}`} />
          </span>
          <select
            aria-label="My status"
            value={status}
            onChange={(e) => setStatus(e.target.value as AgentStatus)}
            className="w-[64px] cursor-pointer appearance-none bg-transparent text-center text-[10.5px] text-ink-4 outline-none hover:text-sheet"
          >
            {(["available", "break", "offline"] as const).map((s) => (
              <option key={s} value={s} className="text-ink">
                {STATUS_META[s].label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </aside>
  );
}
