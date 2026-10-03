"use client";

/**
 * Leads table (Zoho-style).
 *   - Checkbox + Lead name pinned left, row actions (Edit / Delete, or
 *     Restore in the Recycle bin) pinned right, so wide column sets never
 *     hide them.
 *   - Header menu: Manage Columns · Reset Column Size · Records Per Page ·
 *     View Mode (Wrap / Clip text). It sits OUTSIDE the scroll container so
 *     it is never clipped.
 *   - Drag a header's right edge to resize a column (saved per viewer).
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Columns3, Eye, ListOrdered, Pencil, Phone, RotateCcw, SlidersHorizontal, StretchHorizontal, Trash2 } from "lucide-react";
import { StageTag, Tag } from "@/components/ui/primitives";
import { COLUMNS, SOURCE_LABEL, ago, age, relTime, type ColumnKey } from "@/components/leads/meta";
import type { LeadRow } from "@/lib/leads/list";

export const DEFAULT_WIDTH: Record<string, number> = {
  name: 220, phone: 170, email: 210, process: 150, source: 130, campaign: 150, stage: 110, owner: 150,
  outcome: 140, attempts: 90, callback: 130, activity: 120, city: 120, created: 80,
};

export interface GridPrefs {
  columns: ColumnKey[];
  widths: Record<string, number>;
  wrap: boolean;
}

export function LeadsGrid({
  rows,
  prefs,
  onPrefs,
  pageSize,
  onPageSize,
  selected,
  onSelect,
  renderedAt,
  emptyText,
  pending,
  can,
  recycleBin,
  onEdit,
  onDelete,
  onRestore,
}: {
  rows: LeadRow[];
  prefs: GridPrefs;
  onPrefs: (p: GridPrefs) => void;
  pageSize: number;
  onPageSize: (n: number) => void;
  selected: Set<string>;
  onSelect: (next: Set<string>) => void;
  renderedAt: number;
  emptyText: string;
  pending: boolean;
  can: { edit: boolean; delete: boolean };
  recycleBin: boolean;
  onEdit: (id: string) => void;
  onDelete: (row: LeadRow) => void;
  onRestore: (row: LeadRow) => void;
}) {
  const [menu, setMenu] = useState<null | "root" | "columns" | "pages" | "view">(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { columns, widths, wrap } = prefs;
  const has = (k: ColumnKey) => columns.includes(k);
  const w = (k: string) => widths[k] ?? DEFAULT_WIDTH[k] ?? 140;
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const showActions = recycleBin ? can.delete : can.edit || can.delete;

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(null);
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [menu]);

  // Column resize: drag the header's right edge.
  function startResize(e: React.MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = w(key);
    let latest = startW;
    const move = (ev: MouseEvent) => {
      latest = Math.min(600, Math.max(70, startW + ev.clientX - startX));
      const th = document.querySelector<HTMLElement>(`[data-col="${key}"]`);
      if (th) th.style.width = `${latest}px`;
      document.querySelectorAll<HTMLElement>(`[data-cell="${key}"]`).forEach((td) => (td.style.maxWidth = `${latest}px`));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      onPrefs({ ...prefs, widths: { ...widths, [key]: latest } });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const cellText = wrap ? "whitespace-normal break-words" : "overflow-hidden text-ellipsis whitespace-nowrap";
  const cell = (key: string, extra = "") => ({ "data-cell": key, style: { maxWidth: w(key) }, className: `px-3 py-2.5 ${cellText} ${extra}` });

  const th = (k: string, label: string, right?: boolean) => (
      <th key={k} data-col={k} style={{ width: w(k) }} className={`group/th px-3 py-2.5 font-medium whitespace-nowrap ${right ? "text-right" : ""}`}>
        {label}
        <span onMouseDown={(e) => startResize(e, k)} title="Drag to resize" className="absolute top-1.5 right-0 bottom-1.5 w-1.5 cursor-col-resize rounded border-r-2 border-transparent group-hover/th:border-rule-strong hover:!border-teal-ink" />
      </th>
  );

  const menuRow = (Icon: typeof Eye, label: string, onClick: () => void, value?: string, sub?: boolean) => (
    <button key={label} onClick={onClick} className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left text-[13px] hover:bg-paper">
      <Icon size={15} className="text-ink-3" />
      <span className="flex-1">{label}</span>
      {value && <span className="text-[12.5px] font-semibold">{value}</span>}
      {sub && <ChevronRight size={14} className="text-ink-4" />}
    </button>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Scrolls both ways inside the frame; header row and name/actions columns stay pinned. */}
      <div className={`panel min-h-0 flex-1 overflow-auto overscroll-contain transition-opacity ${pending ? "opacity-60" : ""}`}>
        <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr className="text-left text-[11.5px] text-ink-3 [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:border-b [&>th]:border-rule [&>th]:bg-sheet">
              <th className="left-0 !z-30 w-10 pl-4">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={allOn}
                  onChange={(e) => onSelect(e.target.checked ? new Set([...selected, ...rows.map((r) => r.id)]) : new Set([...selected].filter((id) => !rows.some((r) => r.id === id))))}
                  className="h-3.5 w-3.5 accent-[var(--color-ink)]"
                />
              </th>
              <th data-col="name" style={{ width: w("name") }} className="group/th left-10 !z-30 py-2.5 pr-3 pl-1 font-medium whitespace-nowrap shadow-[1px_0_0_var(--color-rule)]">
                Lead name
                <span onMouseDown={(e) => startResize(e, "name")} title="Drag to resize" className="absolute top-1.5 right-0 bottom-1.5 w-1.5 cursor-col-resize rounded border-r-2 border-transparent group-hover/th:border-rule-strong hover:!border-teal-ink" />
              </th>
              {COLUMNS.filter((c) => has(c.key)).map((c) => (
                th(c.key, c.label, c.key === "callback" || c.key === "created" || c.key === "attempts")
              ))}
              {recycleBin && <th className="px-3 py-2.5 font-medium whitespace-nowrap">Deleted</th>}
              {/* Filler: absorbs extra width on wide screens so columns keep their sizes. */}
              <th aria-hidden className="w-full" />
              <th className="right-0 !z-30 w-[92px] pr-3 text-right shadow-[-1px_0_0_var(--color-rule)]">
                <button onClick={() => setMenu(menu ? null : "root")} aria-label="Table settings" title="Table settings" className="inline-flex h-7 w-7 items-center justify-center rounded border border-rule text-ink-3 hover:border-ink-3 hover:text-ink">
                  <SlidersHorizontal size={13} />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const overdue = !!l.nextCallbackAt && new Date(l.nextCallbackAt).getTime() <= renderedAt;
              const on = selected.has(l.id);
              const bg = on ? "bg-[color-mix(in_srgb,var(--color-teal)_12%,var(--color-sheet))]" : "bg-sheet group-hover/row:bg-[color-mix(in_srgb,var(--color-paper)_70%,var(--color-sheet))]";
              return (
                <tr key={l.id} className="group/row [&>td]:border-b [&>td]:border-rule last:[&>td]:border-b-0">
                  <td className={`sticky left-0 z-[1] pl-4 ${bg}`}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${l.name}`}
                      checked={on}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(l.id);
                        else next.delete(l.id);
                        onSelect(next);
                      }}
                      className="h-3.5 w-3.5 accent-[var(--color-ink)]"
                    />
                  </td>
                  <td data-cell="name" style={{ maxWidth: w("name") }} className={`sticky left-10 z-[1] py-2.5 pr-3 pl-1 shadow-[1px_0_0_var(--color-rule)] ${bg} ${cellText}`}>
                    {recycleBin ? <span className="font-semibold">{l.name}</span> : <Link href={`/console?lead=${l.id}`} className="font-semibold hover:underline">{l.name}</Link>}
                    {!has("email") && l.email && <div className="truncate text-[11px] text-ink-4">{l.email}</div>}
                  </td>
                  {has("phone") && (
                    <td {...cell("phone", bg)}>
                      <Link href={`/console?lead=${l.id}`} className="inline-flex items-center gap-1.5 font-mono text-[12.5px] tnum hover:text-teal-ink" title="Open to call">
                        {l.phone} <Phone size={12} className="text-ink-4" />
                      </Link>
                    </td>
                  )}
                  {has("email") && <td {...cell("email", `text-ink-2 ${bg}`)}>{l.email ?? <span className="text-ink-4">—</span>}</td>}
                  {has("process") && <td {...cell("process", `text-ink-2 ${bg}`)}>{l.processName}</td>}
                  {has("source") && <td {...cell("source", bg)}><Tag>{SOURCE_LABEL[l.source] ?? l.source}</Tag></td>}
                  {has("campaign") && <td {...cell("campaign", `text-ink-2 ${bg}`)}>{l.campaign ?? <span className="text-ink-4">—</span>}</td>}
                  {has("stage") && <td {...cell("stage", bg)}>{l.status === "open" ? <StageTag stage={l.stage} /> : <Tag tone={l.status === "won" ? "moss" : "ember"}>{l.status === "dnc" ? "DNC" : l.status[0]!.toUpperCase() + l.status.slice(1)}</Tag>}</td>}
                  {has("owner") && <td {...cell("owner", `text-ink-2 ${bg}`)}>{l.owner ?? <span className="text-ember-ink">Unassigned</span>}</td>}
                  {has("outcome") && <td {...cell("outcome", `text-ink-2 ${bg}`)}>{l.lastDisposition ?? <span className="text-ink-4">—</span>}</td>}
                  {has("attempts") && <td {...cell("attempts", `text-right font-mono text-[12px] tnum ${bg}`)}>{l.attempts}</td>}
                  {has("callback") && (
                    <td {...cell("callback", `text-right font-mono text-[12px] tnum ${overdue ? "font-semibold text-ember-ink" : "text-ink-2"} ${bg}`)}>
                      {l.nextCallbackAt ? relTime(l.nextCallbackAt, renderedAt) : <span className="text-ink-4">—</span>}
                    </td>
                  )}
                  {has("activity") && <td {...cell("activity", `text-ink-3 ${bg}`)}>{l.lastActivityAt ? ago(l.lastActivityAt, renderedAt) : <span className="text-ink-4">—</span>}</td>}
                  {has("city") && <td {...cell("city", `text-ink-2 ${bg}`)}>{l.city ?? <span className="text-ink-4">—</span>}</td>}
                  {has("created") && <td {...cell("created", `text-right font-mono text-[12px] text-ink-3 tnum ${bg}`)}>{age(l.createdAt, renderedAt)}</td>}
                  {recycleBin && <td className={`px-3 py-2.5 whitespace-nowrap text-ink-3 ${bg}`}>{l.deletedAt ? ago(l.deletedAt, renderedAt) : "—"}</td>}
                  <td aria-hidden className={bg} />
                  <td className={`sticky right-0 z-[1] pr-3 text-right whitespace-nowrap shadow-[-1px_0_0_var(--color-rule)] ${bg}`}>
                    {showActions && (
                      <span className="inline-flex gap-1">
                        {recycleBin ? (
                          <button onClick={() => onRestore(l)} title="Restore" aria-label={`Restore ${l.name}`} className="inline-flex h-7 items-center gap-1 rounded border border-rule px-2 text-[12px] text-ink-2 hover:border-ink-3 hover:text-ink">
                            <RotateCcw size={12} /> Restore
                          </button>
                        ) : (
                          <>
                            {can.edit && (
                              <button onClick={() => onEdit(l.id)} title="Edit" aria-label={`Edit ${l.name}`} className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-3 hover:bg-paper hover:text-ink">
                                <Pencil size={14} />
                              </button>
                            )}
                            {can.delete && (
                              <button onClick={() => onDelete(l)} title="Delete" aria-label={`Delete ${l.name}`} className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-3 hover:bg-ember/10 hover:text-ember-ink">
                                <Trash2 size={14} />
                              </button>
                            )}
                          </>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 5} className="px-4 py-14 text-center text-[13px] text-ink-3">{emptyText}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Settings menu — outside the scroll box so it's never clipped. */}
      {menu && (
        <div ref={menuRef} className="absolute top-11 right-2 z-30 flex items-start gap-1.5">
          {menu !== "root" && (
            <div className="w-[230px] rounded-md border border-rule bg-sheet p-1.5 shadow-[0_14px_40px_-12px_rgba(21,23,28,0.3)]">
              {menu === "columns" && (
                <>
                  <div className="eyebrow px-2 pt-1 pb-1.5">Manage columns</div>
                  <div className="max-h-[320px] overflow-y-auto">
                    {COLUMNS.map((c) => (
                      <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] hover:bg-paper">
                        <input
                          type="checkbox"
                          checked={has(c.key)}
                          onChange={(e) => onPrefs({ ...prefs, columns: e.target.checked ? COLUMNS.map((x) => x.key).filter((k) => k === c.key || columns.includes(k)) : columns.filter((k) => k !== c.key) })}
                          className="h-3.5 w-3.5 accent-[var(--color-ink)]"
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                  <button onClick={() => onPrefs({ ...prefs, columns: COLUMNS.filter((c) => c.default).map((c) => c.key) })} className="mt-1 w-full rounded px-2 py-1.5 text-left text-[12px] text-ink-3 hover:bg-paper hover:text-ink">
                    Default columns
                  </button>
                </>
              )}
              {menu === "pages" &&
                [25, 50, 100].map((n) => (
                  <button key={n} onClick={() => (onPageSize(n), setMenu(null))} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[13px] hover:bg-paper">
                    <span className="w-4">{pageSize === n && <Check size={14} />}</span>
                    {n} records
                  </button>
                ))}
              {menu === "view" &&
                ([
                  [true, "Wrap text"],
                  [false, "Clip text"],
                ] as const).map(([v, label]) => (
                  <button key={label} onClick={() => (onPrefs({ ...prefs, wrap: v }), setMenu(null))} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[13px] hover:bg-paper">
                    <span className="w-4">{wrap === v && <Check size={14} />}</span>
                    {label}
                  </button>
                ))}
            </div>
          )}
          <div className="w-[260px] rounded-md border border-rule bg-sheet p-1.5 shadow-[0_14px_40px_-12px_rgba(21,23,28,0.3)]">
            {menuRow(Columns3, "Manage Columns", () => setMenu(menu === "columns" ? "root" : "columns"), undefined, true)}
            {menuRow(StretchHorizontal, "Reset Column Size", () => (onPrefs({ ...prefs, widths: {} }), setMenu(null)))}
            <div className="my-1 border-t border-rule" />
            {menuRow(ListOrdered, "Records Per Page", () => setMenu(menu === "pages" ? "root" : "pages"), String(pageSize), true)}
            {menuRow(Eye, "View Mode", () => setMenu(menu === "view" ? "root" : "view"), wrap ? "Wrap Text" : "Clip Text", true)}
          </div>
        </div>
      )}
    </div>
  );
}
