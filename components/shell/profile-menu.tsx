"use client";

/**
 * Profile panel (Zoho-style): who you are, your role in THIS workspace, and
 * every workspace you can open. Picking one re-issues the session for that
 * workspace (app/(app)/shell-actions.ts) and reloads — settings, leads,
 * telephony and people all switch with it. Super admins also see the
 * workspaces they aren't a member of yet ("Enter").
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, LogOut, Search } from "lucide-react";
import { switchWorkspaceAction, workspacesAction, type WorkspaceOption } from "@/app/(app)/shell-actions";

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  project_supervisor: "Supervisor",
  manager: "Manager",
  process_coordinator: "Coordinator",
  trainer: "Trainer",
  client: "Client",
  agent: "Agent",
};

export function workspaceInitials(name: string) {
  return name.split(/[\s\-_.]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "WS";
}

export function ProfileMenu({
  user,
  workspace,
  onClose,
}: {
  user: { name: string; initials: string; roleLabel: string };
  workspace: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [items, setItems] = useState<WorkspaceOption[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    workspacesAction().then(setItems, () => setItems([]));
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  function open(w: WorkspaceOption) {
    if (w.current) return;
    setError(null);
    setPendingId(w.id);
    startTransition(async () => {
      const r = await switchWorkspaceAction(w.id);
      if (!r.ok) {
        setError(r.error);
        setPendingId(null);
        return;
      }
      // Full navigation: every cached screen belonged to the old workspace.
      window.location.assign(r.home);
    });
  }

  const shown = (items ?? []).filter((w) => w.name.toLowerCase().includes(q.trim().toLowerCase()));
  const members = shown.filter((w) => w.role);
  const others = shown.filter((w) => !w.role);

  return (
    <div ref={ref} role="dialog" aria-label="Profile and workspaces" className="fixed bottom-4 left-[84px] z-50 w-[320px] overflow-hidden rounded-lg border border-rule bg-sheet text-ink shadow-[0_18px_50px_-12px_rgba(21,23,28,0.35)]">
      <div className="flex items-center gap-3 border-b border-rule p-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-[14px] font-semibold text-sheet">{user.initials}</span>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{user.name}</div>
          <div className="text-[12px] text-ink-3">{user.roleLabel} · {workspace}</div>
        </div>
      </div>

      <div className="p-2">
        <div className="flex items-center justify-between px-2 pt-1 pb-2">
          <span className="eyebrow">Workspaces</span>
          {items && items.length > 6 && (
            <label className="flex h-7 w-36 items-center gap-1.5 rounded border border-rule px-2 text-[12px]">
              <Search size={12} className="text-ink-4" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find" className="w-full bg-transparent outline-none" autoFocus />
            </label>
          )}
        </div>
        <ul className="max-h-[300px] overflow-y-auto">
          {items === null && <li className="px-2 py-3 text-[12.5px] text-ink-3">Loading…</li>}
          {members.map((w) => (
            <WorkspaceRow key={w.id} w={w} pending={pendingId === w.id} onPick={() => open(w)} label={ROLE_LABEL[w.role!] ?? w.role!} />
          ))}
          {others.length > 0 && <li className="eyebrow px-2 pt-3 pb-1">Other workspaces · super admin</li>}
          {others.map((w) => (
            <WorkspaceRow key={w.id} w={w} pending={pendingId === w.id} onPick={() => open(w)} label="Enter" />
          ))}
        </ul>
        {error && <p className="mx-2 mt-2 rounded bg-ember/10 px-2 py-1.5 text-[12px] text-ember-ink">{error}</p>}
      </div>

      <div className="border-t border-rule p-2">
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            router.replace("/login");
            router.refresh();
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-[13px] text-ink-2 hover:bg-paper"
        >
          <LogOut size={15} /> Sign out
        </button>
      </div>
    </div>
  );
}

function WorkspaceRow({ w, pending, onPick, label }: { w: WorkspaceOption; pending: boolean; onPick: () => void; label: string }) {
  return (
    <li>
      <button
        onClick={onPick}
        disabled={w.current || pending}
        className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition ${w.current ? "bg-paper" : "hover:bg-paper"}`}
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11.5px] font-semibold ${w.current ? "bg-teal text-ink" : "bg-ink/[0.06] text-ink-2"}`}>{workspaceInitials(w.name)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{w.name}</span>
          <span className="block text-[11.5px] text-ink-3">{pending ? "Switching…" : label}</span>
        </span>
        {w.current && <Check size={15} className="text-teal-ink" />}
      </button>
    </li>
  );
}
