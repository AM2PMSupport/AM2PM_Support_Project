"use client";

/**
 * Setup → Roles & permissions. Shows this workspace's matrix (defaults + its
 * edits, DESIGN.md §7). A Super Admin clicks a cell to toggle V C E D A X I
 * for that role and area; edited cells carry a dot and can be reset to the
 * default. Super Admin's column is locked (lib/auth/rbac.ts LOCKED_ROLES).
 * Saving goes through setRolePermissionAction → lib/admin/roles.ts, which
 * re-checks "Super Admin only" on the server and audits the change.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Lock, RotateCcw } from "lucide-react";
import { setRolePermissionAction } from "@/app/(app)/admin/actions";
import { ACTIONS, LOCKED_ROLES, ROLE_LABEL, ROLES, type Action, type Module } from "@/lib/auth/rbac";
import type { Role } from "@/lib/db/schema";
import { Portal } from "@/components/ui/portal";

const ACTION_LABEL: Record<Action, string> = { V: "View", C: "Create", E: "Edit", D: "Delete", A: "Approve", X: "Export", I: "Import" };
const MODULE_LABEL: Partial<Record<Module, string>> = { config: "Config", import_sources: "Import sources", employees: "Employees (HR)", billing: "Billing (Accounts)" };
const moduleLabel = (m: Module) => MODULE_LABEL[m] ?? m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, " ");

type Row = { module: Module; grants: Partial<Record<Role, string>>; edited: Partial<Record<Role, boolean>> };
type Open = { role: Role; module: Module; rect: DOMRect };

export function RolesPanel({ matrix, myRole, canEdit }: { matrix: Row[]; myRole: Role; canEdit: boolean }) {
  const [open, setOpen] = useState<Open | null>(null);
  const editedCount = matrix.reduce((n, r) => n + Object.keys(r.edited).length, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[760px] text-[12.5px] leading-relaxed text-ink-3">
          {ACTIONS.map((a) => `${a} ${ACTION_LABEL[a].toLowerCase()}`).join(" · ")}. These permissions apply to <span className="font-semibold text-ink">this workspace</span> only.
          Agents see only their own leads; supervisors, managers and coordinators see the processes they’re mapped to; admins and auditors see the whole workspace.
          {canEdit ? " Click a cell to change it; Super Admin stays fixed so nobody is locked out." : " Only a Super Admin can change them."}
        </p>
        {editedCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
            <span className="h-1.5 w-1.5 rounded-full bg-ember" /> {editedCount} changed from default
          </span>
        )}
      </div>
      <div className="panel overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left text-ink-3">
              <th className="sticky left-0 z-[1] bg-sheet px-4 py-2.5 font-medium">Area</th>
              {ROLES.map((r) => (
                <th key={r} className={`px-3 py-2.5 font-medium whitespace-nowrap ${r === myRole ? "text-ink" : ""}`}>
                  <span className="inline-flex items-center gap-1">
                    {ROLE_LABEL[r]}
                    {LOCKED_ROLES.includes(r) && <Lock size={11} className="text-ink-4" aria-label="Fixed" />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map(({ module, grants, edited }) => (
              <tr key={module} className="border-b border-rule last:border-b-0">
                <td className="sticky left-0 z-[1] bg-sheet px-4 py-2 font-medium whitespace-nowrap">{moduleLabel(module)}</td>
                {ROLES.map((r) => {
                  const value = grants[r] ?? "";
                  const editable = canEdit && !LOCKED_ROLES.includes(r);
                  const title = value ? value.split("").map((c) => ACTION_LABEL[c as Action]).join(", ") : "No access";
                  const content = (
                    <>
                      {value || <span className="text-ink-4">–</span>}
                      {edited[r] && <span className="absolute top-1.5 right-1 h-1.5 w-1.5 rounded-full bg-ember" aria-label="changed from default" />}
                    </>
                  );
                  return (
                    <td key={r} className={`px-1.5 py-1 font-mono tnum ${r === myRole ? "bg-teal/10" : ""}`}>
                      {editable ? (
                        <button
                          onClick={(e) => setOpen({ role: r, module, rect: e.currentTarget.getBoundingClientRect() })}
                          title={`${title} — click to change`}
                          className={`relative min-w-[64px] rounded px-1.5 py-1.5 text-left hover:bg-paper hover:ring-1 hover:ring-rule-strong ${open?.role === r && open.module === module ? "bg-paper ring-1 ring-ink" : ""}`}
                        >
                          {content}
                        </button>
                      ) : (
                        <span title={title} className="relative inline-block min-w-[64px] px-1.5 py-1.5">{content}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <Portal>
          <CellEditor
            key={`${open.role}:${open.module}`}
            at={open}
            value={matrix.find((m) => m.module === open.module)?.grants[open.role] ?? ""}
            edited={!!matrix.find((m) => m.module === open.module)?.edited[open.role]}
            onClose={() => setOpen(null)}
          />
        </Portal>
      )}
    </div>
  );
}

function CellEditor({ at, value, edited, onClose }: { at: Open; value: string; edited: boolean; onClose: () => void }) {
  const router = useRouter();
  const [on, setOn] = useState(() => new Set(value.split("")));
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const top = Math.min(at.rect.bottom + 6, window.innerHeight - 260);
  const left = Math.max(8, Math.min(at.rect.left, window.innerWidth - 288));

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

  const save = (reset: boolean) =>
    startTransition(async () => {
      setError(null);
      const actions = ACTIONS.filter((a) => on.has(a)).join("");
      const r = await setRolePermissionAction({ role: at.role, module: at.module, actions }, reset);
      if (!r.ok) return setError(r.error);
      router.refresh();
      onClose();
    });

  const toggle = (a: Action) =>
    setOn((s) => {
      const next = new Set(s);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      // Any other right without View is meaningless: turning one on adds V, turning V off clears all.
      if (a === "V" && !next.has("V")) next.clear();
      if (a !== "V" && next.has(a)) next.add("V");
      return next;
    });

  return (
    <div ref={ref} role="dialog" aria-label="Edit permission" style={{ top, left }} className="fixed z-50 w-[280px] rounded-lg border border-rule bg-sheet p-3 text-ink shadow-[0_18px_50px_-12px_rgba(21,23,28,0.35)]">
      <div className="mb-2 text-[12.5px]">
        <span className="font-semibold">{ROLE_LABEL[at.role]}</span> <span className="text-ink-3">· {moduleLabel(at.module)}</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {ACTIONS.map((a) => (
          <label key={a} className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] ${on.has(a) ? "bg-teal/15" : "hover:bg-paper"}`}>
            <input type="checkbox" checked={on.has(a)} onChange={() => toggle(a)} className="accent-[var(--color-ink)]" />
            <span className="w-3 font-mono font-semibold">{a}</span> {ACTION_LABEL[a]}
          </label>
        ))}
      </div>
      {error && <p className="mt-2 rounded bg-ember/10 px-2 py-1.5 text-[12px] text-ember-ink">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        {edited && (
          <button onClick={() => save(true)} disabled={busy} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] text-ink-3 hover:bg-paper hover:text-ink disabled:opacity-50" title="Back to the default for this role">
            <RotateCcw size={12} /> Default
          </button>
        )}
        <button onClick={onClose} className="ml-auto h-8 rounded-md px-3 text-[12.5px] text-ink-2 hover:bg-paper">Cancel</button>
        <button onClick={() => save(false)} disabled={busy} className="h-8 rounded-md bg-ink px-3 text-[12.5px] font-semibold text-sheet hover:bg-ink-2 disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
