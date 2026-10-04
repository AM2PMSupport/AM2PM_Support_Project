"use client";

/**
 * Leads screen (Zoho-style). Filters, sort and paging live in the URL, so
 * the server renders the right page and a saved filter is just those params.
 * Column choice and page size are remembered per viewer (localStorage);
 * selection drives the bulk bar (reassign / move stage).
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { ArrowDownUp, ChevronLeft, ChevronRight, Columns3, Download, Filter, List, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Kbd } from "@/components/ui/primitives";
import { FilterPanel, type FilterOptions, type SavedView } from "@/components/leads/filter-panel";
import { LeadsGrid, type GridPrefs } from "@/components/leads/leads-grid";
import { EditLead } from "@/components/leads/edit-lead";
import { LeadsBoard } from "@/components/leads/leads-board";
import { CreateLead } from "@/components/leads/create-lead";
import { ProcessPicker } from "@/components/ui/process-picker";
import { AppliedFilters } from "@/components/leads/applied-filters";
import { COLUMNS, DEFAULT_COLUMNS, SORT_LABEL, type ColumnKey } from "@/components/leads/meta";
import { bulkAssignAction, bulkStageAction, deleteLeadsAction, deleteViewAction, restoreLeadsAction, saveViewAction } from "@/app/(app)/leads/actions";
import { classifyQuery } from "@/lib/leads/search-classify";
import type { LeadRow } from "@/lib/leads/list";
import { Portal } from "@/components/ui/portal";

// ── per-viewer table prefs (localStorage; safe when storage is unavailable) ───
const PREFS_KEY = "am2pm.leads.table";
const listeners = new Set<() => void>();
function readPrefs(): string {
  try {
    return localStorage.getItem(PREFS_KEY) ?? "";
  } catch {
    return "";
  }
}
function writePrefs(p: GridPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: keep for this page only */
  }
  memo = JSON.stringify(p);
  listeners.forEach((l) => l());
}
let memo = "";
const snapshot = () => readPrefs() || memo;
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
function parsePrefs(raw: string): GridPrefs {
  try {
    const p = JSON.parse(raw) as Partial<GridPrefs>;
    // Order matters (the viewer's column order); drop unknown/duplicate keys from older versions.
    const known = new Set<string>(COLUMNS.map((c) => c.key));
    const columns = Array.isArray(p.columns) ? [...new Set(p.columns.filter((k): k is ColumnKey => known.has(k)))] : DEFAULT_COLUMNS;
    return { columns, widths: p.widths ?? {}, wrap: !!p.wrap };
  } catch {
    return { columns: DEFAULT_COLUMNS, widths: {}, wrap: false };
  }
}

const KIND_LABEL = { email: "email", phone_exact: "exact phone", phone_partial: "phone digits", name: "name or email" } as const;

export interface LeadsAbilities {
  create: boolean;
  assign: boolean;
  editStage: boolean;
  exportCsv: boolean;
  share: boolean;
  delete: boolean;
  seeOwners: boolean;
}

export function LeadsWorkspace({
  rows,
  total,
  nextCursor,
  prevCursor,
  options,
  views,
  can,
  renderedAt,
}: {
  rows: LeadRow[];
  total: number;
  nextCursor: string | null;
  prevCursor: string | null;
  options: FilterOptions;
  views: SavedView[];
  can: LeadsAbilities;
  renderedAt: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const params = useMemo(() => Object.fromEntries(sp.entries()) as Record<string, string>, [sp]);
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.q ?? "");
  // null = default by screen size (rail on ≥lg, hidden below); then the Filter button decides.
  const [filtersOpen, setFiltersOpen] = useState<boolean | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const view = params.view === "board" ? "board" : "list";
  const pageSize = Number(params.limit ?? 50);

  const stored = useSyncExternalStore(subscribe, snapshot, () => "");
  const prefs = useMemo(() => parsePrefs(stored), [stored]);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ ids: string[]; label: string } | null>(null);
  const recycleBin = params.status === "deleted";
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  // Only rows on this page can be selected; a filter change drops the rest.
  const selected = useMemo(() => new Set([...picked].filter((id) => rows.some((r) => r.id === id))), [picked, rows]);

  function go(next: Record<string, string>, keepCursor = false) {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k));
    if (!keepCursor) {
      p.delete("cursor");
      p.delete("before");
      p.delete("page");
    }
    startTransition(() => router.replace(`${pathname}?${p.toString()}`, { scroll: false }));
  }

  // Debounced search → URL.
  useEffect(() => {
    if (q === (params.q ?? "")) return;
    const t = setTimeout(() => go({ q: q.trim() }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const stagesForBoard = useMemo(() => {
    const procs = params.process ? options.processes.filter((p) => params.process!.split(",").includes(p.id)) : options.processes;
    return [...new Set(procs.flatMap((p) => p.stages))];
  }, [options.processes, params.process]);

  const kind = classifyQuery(q);
  const from = rows.length ? (page - 1) * pageSize + 1 : 0;
  const to = rows.length ? from + rows.length - 1 : 0;
  function turn(dir: "next" | "prev") {
    const p = new URLSearchParams(sp.toString());
    p.delete("cursor");
    p.delete("before");
    if (dir === "next" && nextCursor) p.set("cursor", nextCursor);
    if (dir === "prev" && prevCursor) p.set("before", prevCursor);
    const n = dir === "next" ? page + 1 : page - 1;
    if (n > 1 && !(dir === "prev" && !prevCursor)) p.set("page", String(n));
    else p.delete("page");
    startTransition(() => router.replace(`${pathname}?${p.toString()}`, { scroll: false }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  const filtersOn = Object.entries(params).some(([k, v]) => v && !["sort", "view", "limit", "cursor", "before", "page"].includes(k) && !(k === "status" && v === "open"));

  async function runBulk(fn: () => Promise<{ ok: boolean; data?: { moved: number; skipped: number }; error?: string }>, verb: string) {
    setBulkMsg(null);
    const r = await fn();
    if (!r.ok) return setBulkMsg(r.error ?? "Failed");
    const { moved, skipped } = r.data!;
    setBulkMsg(`${verb} ${moved} lead${moved === 1 ? "" : "s"}${skipped ? ` · ${skipped} skipped (closed, not in scope, or agent not on that process)` : ""}`);
    setPicked(new Set());
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      {/* Toolbar — fixed above the scrolling list */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          onClick={() => setFiltersOpen(!(filtersOpen ?? (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches)))}
          aria-pressed={filtersOpen ?? undefined}
          className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium ${filtersOpen === false ? "border-rule bg-sheet text-ink-2 hover:border-ink-3" : filtersOpen ? "border-ink bg-ink text-sheet" : "border-rule bg-sheet text-ink-2 hover:border-ink-3 lg:border-ink lg:bg-ink lg:text-sheet"}`}
        >
          <Filter size={14} /> Filter
        </button>
        <div className="relative">
          <button onClick={() => setSortOpen(!sortOpen)} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule bg-sheet px-3 text-[12.5px] font-medium text-ink-2 hover:border-ink-3">
            <ArrowDownUp size={14} /> {SORT_LABEL[params.sort ?? "newest"]}
          </button>
          {sortOpen && (
            <div className="absolute top-10 left-0 z-30 w-44 rounded-md border border-rule bg-sheet p-1 shadow-[0_14px_40px_-12px_rgba(21,23,28,0.3)]" onMouseLeave={() => setSortOpen(false)}>
              {Object.entries(SORT_LABEL).map(([k, l]) => (
                <button key={k} onClick={() => (go({ sort: k === "newest" ? "" : k }), setSortOpen(false))} className={`block w-full rounded px-2.5 py-1.5 text-left text-[12.5px] ${(params.sort ?? "newest") === k ? "bg-paper font-semibold" : "hover:bg-paper"}`}>
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex h-9 items-center rounded-md border border-rule bg-sheet p-0.5">
          {(["list", "board"] as const).map((v) => (
            <button key={v} onClick={() => go({ view: v === "list" ? "" : v }, true)} aria-label={v === "list" ? "List view" : "Board view"} title={v === "list" ? "List" : "Board (by stage)"} className={`flex h-8 w-9 items-center justify-center rounded-[4px] ${view === v ? "bg-ink text-sheet" : "text-ink-3 hover:text-ink"}`}>
              {v === "list" ? <List size={15} /> : <Columns3 size={15} />}
            </button>
          ))}
        </div>

        <ProcessPicker processes={options.processes} value={params.process ? params.process.split(",") : []} onChange={(ids) => go({ process: ids.join(",") })} />
        <label className="ml-1 flex h-9 w-full max-w-[380px] items-center gap-2 rounded-md border border-rule bg-sheet px-3 focus-within:border-ink">
          <Search size={15} className="text-ink-3" />
          <input id="leads-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, last 4 digits, full number, or email" className="h-full flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-4" aria-label="Search leads" />
          {q ? <button onClick={() => setQ("")} aria-label="Clear search" className="text-ink-3 hover:text-ink"><X size={14} /></button> : <Kbd>/</Kbd>}
        </label>
        {kind && <span className="text-[12px] text-ink-3">by <span className="font-semibold text-ink">{KIND_LABEL[kind.kind]}</span>{pending ? "…" : ""}</span>}

        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[12px] text-ink-3 tnum">{total ? `${from}–${to} of ${total.toLocaleString("en-IN")}` : "0 leads"}</span>
          {can.exportCsv && (
            <a href={`/api/v1/leads/export?${new URLSearchParams(Object.entries(params).filter(([k]) => k !== "cursor" && k !== "view")).toString()}`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule bg-sheet px-3 text-[12.5px] font-medium text-ink-2 hover:border-ink-3" title="Download these leads as CSV">
              <Download size={14} /> Export
            </a>
          )}
          {can.create && (
            <button onClick={() => setCreating(true)} disabled={!options.processes.length} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-ink px-4 text-[12.5px] font-semibold text-sheet hover:bg-ink-2 disabled:bg-ink-4">
              <Plus size={14} /> Create Lead
            </button>
          )}
        </div>
      </div>

      {/* What is filtered right now — visible even when the filter rail is hidden. */}
      <AppliedFilters className="shrink-0" params={params} options={options} onChange={(patch) => go(patch)} />

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-ink bg-ink px-4 py-2.5 text-[12.5px] text-sheet">
          <span className="font-semibold">{selected.size} selected</span>
          {can.assign && !recycleBin && (
            <select
              aria-label="Assign selected to"
              value=""
              onChange={(e) => e.target.value && runBulk(() => bulkAssignAction({ leadIds: [...selected], ownerId: e.target.value }), "Assigned")}
              className="h-8 rounded bg-white/10 px-2 text-sheet outline-none"
            >
              <option value="" className="text-ink">Assign to…</option>
              {options.owners.map((o) => <option key={o.id} value={o.id} className="text-ink">{o.name}</option>)}
            </select>
          )}
          {can.editStage && !recycleBin && (
            <select
              aria-label="Move selected to stage"
              value=""
              onChange={(e) => e.target.value && runBulk(() => bulkStageAction({ leadIds: [...selected], stage: e.target.value }), "Moved")}
              className="h-8 rounded bg-white/10 px-2 text-sheet outline-none"
            >
              <option value="" className="text-ink">Move to stage…</option>
              {stagesForBoard.map((s) => <option key={s} value={s} className="text-ink">{s}</option>)}
            </select>
          )}
          {can.delete && !recycleBin && (
            <button onClick={() => setConfirm({ ids: [...selected], label: `${selected.size} lead${selected.size === 1 ? "" : "s"}` })} className="inline-flex h-8 items-center gap-1.5 rounded bg-ember px-3 font-semibold text-sheet">
              <Trash2 size={13} /> Delete
            </button>
          )}
          {can.delete && recycleBin && (
            <button onClick={() => runBulk(async () => { const r = await restoreLeadsAction({ leadIds: [...selected] }); return r.ok ? { ok: true, data: { moved: r.data!.restored, skipped: r.data!.skipped } } : r; }, "Restored")} className="inline-flex h-8 items-center gap-1.5 rounded bg-white/15 px-3 font-semibold text-sheet">
              <RotateCcw size={13} /> Restore
            </button>
          )}
          <button onClick={() => setPicked(new Set())} className="ml-auto text-sheet/70 hover:text-sheet">Clear selection</button>
        </div>
      )}
      {bulkMsg && (
        <p className="flex items-center justify-between rounded-md bg-teal/15 px-3 py-2 text-[12.5px]">
          {bulkMsg}
          <button onClick={() => setBulkMsg(null)} aria-label="Dismiss"><X size={13} /></button>
        </p>
      )}

      <div className="relative flex min-h-0 flex-1 gap-4">
        {filtersOpen !== false && (
          <FilterPanel
            className={`${filtersOpen ? "flex" : "hidden lg:flex"} absolute inset-y-0 left-0 z-30 shadow-[8px_0_30px_-12px_rgba(21,23,28,0.35)] lg:static lg:shadow-none`}
            params={params}
            options={options}
            views={views}
            showOwners={can.seeOwners}
            canShare={can.share}
            canSeeBin={can.delete}
            onChange={(next) => go(next)}
            onApplyView={(v) => {
              setQ(v.query.q ?? "");
              startTransition(() => router.replace(`${pathname}?${new URLSearchParams({ ...v.query, ...(params.view ? { view: params.view } : {}) }).toString()}`, { scroll: false }));
            }}
            onSaveView={async (name, shared) => {
              const query = Object.fromEntries(Object.entries(params).filter(([k]) => !["cursor", "view", "limit"].includes(k)));
              const r = await saveViewAction({ name, query, shared });
              if (!r.ok) return r.error;
              startTransition(() => router.refresh());
              return null;
            }}
            onDeleteView={async (id) => {
              await deleteViewAction(id);
              startTransition(() => router.refresh());
            }}
          />
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {view === "board" ? (
            <div className="min-h-0 flex-1 overflow-auto">
            <LeadsBoard
              key={sp.toString()}
              rows={rows}
              stages={stagesForBoard}
              canMove={can.editStage}
              renderedAt={renderedAt}
              onMove={async (leadId, stage) => {
                const r = await bulkStageAction({ leadIds: [leadId], stage });
                if (!r.ok) return r.error;
                if (!r.data?.moved) return "can't move this lead to that stage";
                startTransition(() => router.refresh());
                return null;
              }}
            />
            </div>
          ) : (
            <LeadsGrid
              rows={rows}
              prefs={prefs}
              onPrefs={writePrefs}
              pageSize={pageSize}
              onPageSize={(n) => go({ limit: n === 50 ? "" : String(n) })}
              selected={selected}
              onSelect={setPicked}
              renderedAt={renderedAt}
              pending={pending}
              can={{ edit: can.editStage, delete: can.delete }}
              recycleBin={recycleBin}
              onEdit={setEditing}
              onDelete={(l) => setConfirm({ ids: [l.id], label: l.name })}
              onRestore={(l) => runBulk(async () => { const r = await restoreLeadsAction({ leadIds: [l.id] }); return r.ok ? { ok: true, data: { moved: r.data!.restored, skipped: r.data!.skipped } } : r; }, "Restored")}
              emptyText={recycleBin ? "The recycle bin is empty." : q ? `No leads match “${q}”. Search needs 2+ letters or 3+ digits.` : filtersOn ? "No leads match these filters." : "No leads here yet."}
            />
          )}

          {/* Pagination: keyset both ways, so every page loads equally fast at any depth. */}
          {total > 0 && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-rule pt-2 text-[12.5px] text-ink-3">
              <div className="flex items-center gap-2">
                Records per page
                <div className="flex rounded-md border border-rule bg-sheet p-0.5">
                  {[25, 50, 100].map((n) => (
                    <button key={n} onClick={() => go({ limit: n === 50 ? "" : String(n) })} className={`h-7 rounded-[4px] px-2.5 font-medium ${pageSize === n ? "bg-ink text-sheet" : "hover:text-ink"}`}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono tnum">
                  {from.toLocaleString("en-IN")}–{to.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")} · page {page} of {Math.max(1, Math.ceil(total / pageSize))}
                </span>
                <button onClick={() => turn("prev")} disabled={!prevCursor || pending} aria-label="Previous page" className="inline-flex h-8 items-center gap-1 rounded-md border border-rule bg-sheet px-2.5 font-medium text-ink-2 hover:border-ink-3 disabled:opacity-40">
                  <ChevronLeft size={14} /> Prev
                </button>
                <button onClick={() => turn("next")} disabled={!nextCursor || pending} aria-label="Next page" className="inline-flex h-8 items-center gap-1 rounded-md border border-rule bg-sheet px-2.5 font-medium text-ink-2 hover:border-ink-3 disabled:opacity-40">
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {editing && <EditLead leadId={editing} owners={options.owners} onClose={() => setEditing(null)} onSaved={() => startTransition(() => router.refresh())} />}

      {confirm && (
        <Portal>
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onMouseDown={(e) => e.target === e.currentTarget && setConfirm(null)}>
          <div role="alertdialog" aria-label="Delete leads" className="w-[400px] rounded-lg border border-rule bg-sheet p-5 shadow-[0_24px_60px_-20px_rgba(21,23,28,0.45)]">
            <h3 className="text-[15px] font-semibold">Delete {confirm.label}?</h3>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
              Moves to the Recycle bin (Leads → Status → Deleted). Pending callbacks are cancelled and the agent’s capacity is freed. An admin can restore it later.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className="h-9 rounded-md border border-rule px-4 text-[13px] font-medium text-ink-2 hover:border-ink-3">Cancel</button>
              <button
                autoFocus
                onClick={() => {
                  const ids = confirm.ids;
                  setConfirm(null);
                  runBulk(async () => {
                    const r = await deleteLeadsAction({ leadIds: ids });
                    return r.ok ? { ok: true, data: { moved: r.data!.deleted, skipped: r.data!.skipped } } : r;
                  }, "Deleted");
                }}
                className="h-9 rounded-md bg-ember px-4 text-[13px] font-semibold text-sheet"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {creating && (
        <CreateLead
          processes={options.processes}
          owners={options.owners}
          canPickOwner={can.assign}
          onClose={() => setCreating(false)}
          onCreated={() => startTransition(() => router.refresh())}
        />
      )}
    </div>
  );
}
