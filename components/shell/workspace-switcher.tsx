"use client";

/**
 * Workspace switcher (Zoho-style "jump to organisation"), in every screen's
 * top bar, first (before the title), so the person always sees which workspace they
 * are working in. The chip shows the workspace; its drop-down lists every
 * workspace they can open (super admins also see the ones they aren't a member
 * of yet: "Enter"). Picking one re-issues the session for that workspace
 * (app/(app)/shell-actions.ts) and reloads on the same module when the new
 * role may open it (lib/auth/rbac.ts landingAfterSwitch).
 *
 * The workspace name comes from WorkspaceProvider (set once by the (app)
 * layout from the session), so each page's <Topbar> doesn't need to pass it.
 * The drop-down is portalled: the top bar's backdrop blur makes it a
 * containing block, which would clip fixed overlays like the switch loader.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { switchWorkspaceAction, workspacesAction, type WorkspaceOption } from "@/app/(app)/shell-actions";
import { BrandLoader } from "@/components/ui/brand-loader";
import { Portal } from "@/components/ui/portal";
import { ROLE_LABEL } from "@/lib/auth/rbac";
import type { Role } from "@/lib/db/schema";


export function workspaceInitials(name: string) {
  return name.split(/[\s\-_.]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "WS";
}

const WorkspaceContext = createContext<string | null>(null);

export function WorkspaceProvider({ workspace, children }: { workspace: string; children: ReactNode }) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}

export function WorkspaceSwitcher() {
  const workspace = useContext(WorkspaceContext);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!workspace) return null;
  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Workspace: ${workspace} — click to switch`}
        className={`flex h-9 max-w-[240px] shrink-0 items-center gap-2 rounded-md border bg-sheet pr-2 pl-1 transition ${open ? "border-ink" : "border-rule hover:border-ink-3"}`}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] bg-teal font-mono text-[11px] font-semibold text-ink">{workspaceInitials(workspace)}</span>
        <span className="hidden truncate text-[13px] font-semibold sm:block">{workspace}</span>
        <ChevronDown size={14} className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <Portal>
          <WorkspaceMenu anchor={btn} onClose={() => setOpen(false)} />
        </Portal>
      )}
    </>
  );
}

function WorkspaceMenu({ anchor, onClose }: { anchor: React.RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const [items, setItems] = useState<WorkspaceOption[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    workspacesAction().then(setItems, () => setItems([]));
  }, []);

  // Drop down from the chip, kept inside the window on narrow screens.
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 328)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  // Close on outside click / Escape (a click on the chip itself toggles it).
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);

  function pick(w: WorkspaceOption) {
    if (w.current) return;
    setError(null);
    setPendingId(w.id);
    startTransition(async () => {
      const r = await switchWorkspaceAction(w.id, window.location.pathname + window.location.search);
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
    <div
      ref={ref}
      role="dialog"
      aria-label="Switch workspace"
      style={pos ?? { visibility: "hidden" }}
      className="fixed z-50 w-[320px] overflow-hidden rounded-lg border border-rule bg-sheet p-2 text-ink shadow-[0_18px_50px_-12px_rgba(21,23,28,0.35)]"
    >
      <div className="flex items-center justify-between px-2 pt-1 pb-2">
        <span className="eyebrow">Workspaces</span>
        {items && items.length > 6 && (
          <label className="flex h-7 w-36 items-center gap-1.5 rounded border border-rule px-2 text-[12px]">
            <Search size={12} className="text-ink-4" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find" className="w-full bg-transparent outline-none" autoFocus />
          </label>
        )}
      </div>
      <ul className="max-h-[360px] overflow-y-auto">
        {items === null &&
          Array.from({ length: 3 }, (_, i) => (
            <li key={i} aria-hidden="true" className="flex items-center gap-3 px-2 py-2">
              <span className="skeleton h-8 w-8 shrink-0 rounded-md" />
              <span className="flex flex-1 flex-col gap-1.5">
                <span className="skeleton h-3.5 w-[60%]" />
                <span className="skeleton h-3 w-[35%]" />
              </span>
            </li>
          ))}
        {members.map((w) => (
          <WorkspaceRow key={w.id} w={w} pending={pendingId === w.id} onPick={() => pick(w)} label={ROLE_LABEL[w.role as Role] ?? w.role!} />
        ))}
        {others.length > 0 && <li className="eyebrow px-2 pt-3 pb-1">Other workspaces · super admin</li>}
        {others.map((w) => (
          <WorkspaceRow key={w.id} w={w} pending={pendingId === w.id} onPick={() => pick(w)} label="Enter" />
        ))}
        {items !== null && shown.length === 0 && <li className="px-2 py-3 text-[12.5px] text-ink-3">No workspace matches.</li>}
      </ul>
      {error && <p className="mx-2 mt-2 rounded bg-ember/10 px-2 py-1.5 text-[12px] text-ember-ink">{error}</p>}

      {/* Full page reload follows; inside the panel so the outside-click handler doesn't close it. */}
      {pendingId && <BrandLoader overlay label={`Switching to ${items?.find((w) => w.id === pendingId)?.name ?? "workspace"}`} />}
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
