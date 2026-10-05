"use client";

/**
 * Setup → Roles & permissions. Two grids over one DRAFT of this workspace's
 * grants (defaults + its edits, DESIGN.md §7):
 *  - Module access: one switch per role × sidebar module (`screen.<name>`).
 *    Ticking a module the role can't use yet also adds View on the area it
 *    needs (SCREEN_NEEDS), so the module works.
 *  - Permissions: click a cell to toggle V C E D A X I.
 * Nothing is saved until Save, which sends every changed cell in one
 * transaction (saveRolePermissionsAction → lib/admin/roles.ts: Super Admin
 * only, audited). Cancel drops the draft; Default puts every role back to the
 * defaults (still needs Save). Super Admin's column is locked.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Lock, RotateCcw } from "lucide-react";
import { saveRolePermissionsAction } from "@/app/(app)/admin/actions";
import {
  ACTIONS,
  effectiveGrants,
  GRANT_KEYS,
  LOCKED_ROLES,
  navAvailable,
  normalizeActions,
  permissionMatrix,
  ROLE_LABEL,
  ROLES,
  SCREEN_NEEDS,
  screenMatrix,
  type Action,
  type Module,
  type Screen,
} from "@/lib/auth/rbac";
import type { Role } from "@/lib/db/schema";
import { Portal } from "@/components/ui/portal";

const ACTION_LABEL: Record<Action, string> = { V: "View", C: "Create", E: "Edit", D: "Delete", A: "Approve", X: "Export", I: "Import" };
const MODULE_LABEL: Partial<Record<Module, string>> = { config: "Config", import_sources: "Import sources", employees: "Employees (HR)", billing: "Billing (Accounts)" };
const moduleLabel = (m: Module) => MODULE_LABEL[m] ?? m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, " ");
const SCREEN_LABEL: Record<Screen, string> = { console: "Console", leads: "Leads", calls: "Calls", dashboard: "Floor", admin: "Setup", soon: "Coming soon" };

type Edit = { role: string; module: string; actions: string };
/** Draft: "role|key" → actions, for every editable role × key. */
type Draft = Record<string, string>;

const EDITABLE = ROLES.filter((r) => !LOCKED_ROLES.includes(r));
const cellKey = (role: string, key: string) => `${role}|${key}`;
function toDraft(edits: Edit[]): Draft {
  const d: Draft = {};
  for (const r of EDITABLE) {
    const g = effectiveGrants(r, edits);
    for (const k of GRANT_KEYS) d[cellKey(r, k)] = g[k] ?? "";
  }
  return d;
}
const toEdits = (d: Draft): Edit[] =>
  Object.entries(d).map(([k, actions]) => {
    const [role, module] = k.split("|") as [string, string];
    return { role, module, actions };
  });
const DEFAULT_DRAFT = toDraft([]);
const sameDraft = (a: Draft, b: Draft) => Object.keys(a).every((k) => a[k] === b[k]);

type Open = { role: Role; module: Module; rect: DOMRect };

/** `edits` = this workspace's stored role_permissions rows. Remount (key) after a save to start from the new state. */
export function RolesPanel({ edits, myRole, canEdit }: { edits: Edit[]; myRole: Role; canEdit: boolean }) {
  const router = useRouter();
  const saved = useMemo(() => toDraft(edits), [edits]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [open, setOpen] = useState<Open | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const draftEdits = useMemo(() => toEdits(draft), [draft]);
  const matrix = useMemo(() => permissionMatrix(draftEdits), [draftEdits]);
  const screens = useMemo(() => screenMatrix(draftEdits), [draftEdits]);
  const changes = useMemo(() => draftEdits.filter((e) => saved[cellKey(e.role, e.module)] !== e.actions), [draftEdits, saved]);
  const unsaved = (role: Role, key: string) => !LOCKED_ROLES.includes(role) && draft[cellKey(role, key)] !== saved[cellKey(role, key)];
  const isDefault = sameDraft(draft, DEFAULT_DRAFT);

  const setCell = (role: Role, key: string, actions: string) =>
    setDraft((d) => {
      const next = { ...d, [cellKey(role, key)]: actions };
      // Module switched on but the role can't use it yet → add View on the area it needs.
      if (key.startsWith("screen.") && actions) {
        const screen = key.slice(7) as Screen;
        const need = SCREEN_NEEDS[screen];
        const grants = effectiveGrants(role, toEdits(next));
        if (need && !navAvailable({ role, grants }).includes(screen)) next[cellKey(role, need)] = normalizeActions((grants[need] ?? "") + "V");
      }
      return next;
    });

  const save = () =>
    startTransition(async () => {
      setError(null);
      const r = await saveRolePermissionsAction(changes);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-3">
      {canEdit && (
        <div className="sticky top-0 z-[2] flex flex-wrap items-center gap-2 rounded-md border border-rule bg-sheet px-3 py-2">
          <span className="text-[12.5px] text-ink-3">
            {changes.length ? (
              <>
                <span className="font-semibold text-ink">{changes.length}</span> unsaved change{changes.length === 1 ? "" : "s"}
              </>
            ) : (
              "No unsaved changes"
            )}
          </span>
          {error && <span className="rounded bg-ember/10 px-2 py-1 text-[12px] text-ember-ink">{error}</span>}
          <button
            onClick={() => setDraft(DEFAULT_DRAFT)}
            disabled={busy || isDefault}
            title="Put every role's module access and permissions back to the defaults (then Save)"
            className="ml-auto inline-flex h-8 items-center gap-1 rounded-md px-3 text-[12.5px] text-ink-2 hover:bg-paper disabled:opacity-40"
          >
            <RotateCcw size={12} /> Default
          </button>
          <button onClick={() => (setDraft(saved), setError(null))} disabled={busy || !changes.length} className="h-8 rounded-md px-3 text-[12.5px] text-ink-2 hover:bg-paper disabled:opacity-40">
            Cancel
          </button>
          <button onClick={save} disabled={busy || !changes.length} className="h-8 rounded-md bg-ink px-3 text-[12.5px] font-semibold text-sheet hover:bg-ink-2 disabled:opacity-40">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      <h3 className="text-[13px] font-semibold">Module access</h3>
      <p className="max-w-[760px] text-[12.5px] leading-relaxed text-ink-3">
        Which modules each role sees in the sidebar of this workspace. Ticking a module the role can’t use yet also gives it View on that area below (e.g. Leads · V); they then see the processes they’re mapped to.
        {canEdit ? "" : " Only a Super Admin can change them."}
      </p>
      <div className="panel overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <RoleHead first="Module" myRole={myRole} />
          <tbody>
            {screens.map(({ screen, on, available, edited }) => (
              <tr key={screen} className="border-b border-rule last:border-b-0">
                <td className="sticky left-0 z-[1] bg-sheet px-4 py-2 font-medium whitespace-nowrap">{SCREEN_LABEL[screen]}</td>
                {ROLES.map((r) => {
                  const usable = !!available[r];
                  const editable = canEdit && !LOCKED_ROLES.includes(r) && !busy;
                  const checked = usable && !!on[r];
                  const title = checked ? "Visible" : usable ? "Hidden" : "Hidden — ticking also grants View";
                  return (
                    <td key={r} className={`px-3 py-2 ${r === myRole ? "bg-teal/10" : ""}`}>
                      <label title={title} className={`relative inline-flex items-center rounded p-0.5 ${editable ? "cursor-pointer" : "opacity-40"} ${unsaved(r, `screen.${screen}`) ? "ring-2 ring-teal" : ""}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!editable}
                          onChange={(e) => setCell(r, `screen.${screen}`, e.target.checked ? "V" : "")}
                          aria-label={`${SCREEN_LABEL[screen]} for ${ROLE_LABEL[r]}`}
                          className="h-4 w-4 accent-[var(--color-ink)]"
                        />
                        {edited[r] && <span className="absolute -top-1 -right-2 h-1.5 w-1.5 rounded-full bg-ember" aria-label="changed from default" />}
                      </label>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-3 text-[13px] font-semibold">Permissions</h3>
      <p className="max-w-[760px] text-[12.5px] leading-relaxed text-ink-3">
        {ACTIONS.map((a) => `${a} ${ACTION_LABEL[a].toLowerCase()}`).join(" · ")}. These permissions apply to <span className="font-semibold text-ink">this workspace</span> only.
        Agents see only their own leads; supervisors, managers, coordinators and other roles given lead access see the processes they’re mapped to; admins and auditors see the whole workspace.
        {canEdit ? " Click a cell to change it; Super Admin stays fixed so nobody is locked out." : " Only a Super Admin can change them."}{" "}
        <span className="inline-flex items-center gap-1 align-middle">
          <span className="h-1.5 w-1.5 rounded-full bg-ember" /> changed from default
        </span>
        {canEdit && (
          <span className="ml-2 inline-flex items-center gap-1 align-middle">
            <span className="h-2.5 w-2.5 rounded-sm ring-2 ring-teal" /> not saved yet
          </span>
        )}
      </p>
      <div className="panel overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <RoleHead first="Area" myRole={myRole} />
          <tbody>
            {matrix.map(({ module, grants, edited }) => (
              <tr key={module} className="border-b border-rule last:border-b-0">
                <td className="sticky left-0 z-[1] bg-sheet px-4 py-2 font-medium whitespace-nowrap">{moduleLabel(module)}</td>
                {ROLES.map((r) => {
                  const value = grants[r] ?? "";
                  const editable = canEdit && !LOCKED_ROLES.includes(r) && !busy;
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
                          className={`relative min-w-[64px] rounded px-1.5 py-1.5 text-left hover:bg-paper hover:ring-1 hover:ring-rule-strong ${unsaved(r, module) ? "ring-2 ring-teal" : ""} ${open?.role === r && open.module === module ? "bg-paper ring-1 ring-ink" : ""}`}
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
            value={draft[cellKey(open.role, open.module)] ?? ""}
            fallback={DEFAULT_DRAFT[cellKey(open.role, open.module)] ?? ""}
            onApply={(actions) => setCell(open.role, open.module, actions)}
            onClose={() => setOpen(null)}
          />
        </Portal>
      )}
    </div>
  );
}

function RoleHead({ first, myRole }: { first: string; myRole: Role }) {
  return (
    <thead>
      <tr className="border-b border-rule text-left text-ink-3">
        <th className="sticky left-0 z-[1] bg-sheet px-4 py-2.5 font-medium">{first}</th>
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
  );
}

/** One cell's letters. Changes go into the draft; the page's Save writes them. */
function CellEditor({ at, value, fallback, onApply, onClose }: { at: Open; value: string; fallback: string; onApply: (actions: string) => void; onClose: () => void }) {
  const [on, setOn] = useState(() => new Set(value.split("")));
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

  const apply = (actions: string) => {
    onApply(actions);
    onClose();
  };

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
      <div className="mt-3 flex items-center gap-2">
        {value !== fallback && (
          <button onClick={() => apply(fallback)} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] text-ink-3 hover:bg-paper hover:text-ink" title="Back to the default for this role">
            <RotateCcw size={12} /> Default
          </button>
        )}
        <button onClick={onClose} className="ml-auto h-8 rounded-md px-3 text-[12.5px] text-ink-2 hover:bg-paper">Cancel</button>
        <button onClick={() => apply(ACTIONS.filter((a) => on.has(a)).join(""))} className="h-8 rounded-md bg-ink px-3 text-[12.5px] font-semibold text-sheet hover:bg-ink-2">
          Apply
        </button>
      </div>
    </div>
  );
}
