"use client";

/**
 * Left rail. Ink background so the paper workspace reads as the "desk".
 * Bottom: the agent's own status switch — the single most-used control in a
 * call center, so it lives here, always visible. The avatar (and the
 * workspace badge under the logo) open the profile panel with the
 * workspace switcher.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AudioLines, BarChart3, Headset, Settings2, UsersRound } from "lucide-react";
import { LogoMark } from "@/components/ui/logo";
import type { AgentStatus } from "@/lib/ui/sample-data";
import { STATUS_META } from "@/lib/ui/status";
import { ProfileMenu, workspaceInitials } from "@/components/shell/profile-menu";
import { Portal } from "@/components/ui/portal";

const NAV = [
  { key: "console", href: "/console", label: "Console", icon: Headset },
  { key: "leads", href: "/leads", label: "Leads", icon: UsersRound },
  { key: "calls", href: "/calls", label: "Calls", icon: AudioLines },
  { key: "dashboard", href: "/dashboard", label: "Floor", icon: BarChart3 },
  { key: "admin", href: "/admin", label: "Setup", icon: Settings2 },
] as const;


export function Sidebar({
  user,
  workspace,
  nav,
  canTakeCalls,
}: {
  user: { name: string; initials: string; roleLabel: string };
  workspace: string;
  nav: readonly string[];
  canTakeCalls: boolean;
}) {
  const path = usePathname();
  const [status, setStatus] = useState<AgentStatus>("available");
  const [menu, setMenu] = useState(false);

  return (
    <aside className="sticky top-0 flex h-dvh w-[76px] shrink-0 flex-col items-center border-r border-black/40 bg-ink py-4 text-sheet">
      <Link href="/console" aria-label="AM2PM CRM home" className="mb-3">
        <LogoMark size={30} />
      </Link>
      <button
        onClick={() => setMenu(true)}
        title={`Workspace: ${workspace} — click to switch`}
        className="mb-6 flex h-7 min-w-[44px] items-center justify-center rounded-md border border-white/15 px-1.5 font-mono text-[10.5px] font-semibold tracking-wide text-teal hover:border-teal/60"
      >
        {workspaceInitials(workspace)}
      </button>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV.filter((n) => nav.includes(n.key)).map(({ href, label, icon: Icon }) => {
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
        <div className="group relative flex flex-col items-center gap-1 text-[10px] text-ink-4">
          <button
            onClick={() => setMenu(true)}
            aria-label="Profile and workspaces"
            title={`${user.name} · ${user.roleLabel} · ${workspace}`}
            className="relative flex h-[34px] w-[34px] items-center justify-center rounded-full bg-white/10 text-[12px] font-semibold text-sheet hover:bg-white/20"
          >
            {user.initials}
            <span className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-ink ${STATUS_META[status].dot}`} />
          </button>
          {canTakeCalls ? (
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
          ) : (
            <span className="w-[64px] truncate text-center text-[10.5px]">{user.roleLabel}</span>
          )}
        </div>
      </div>
      {/* Portal: the sticky sidebar is its own stacking context; inside it the menu fell under page content. */}
      {menu && (
        <Portal>
          <ProfileMenu user={user} workspace={workspace} onClose={() => setMenu(false)} />
        </Portal>
      )}
    </aside>
  );
}
