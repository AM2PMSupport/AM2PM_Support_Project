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
 *   - Column ORDER is the viewer's: drag rows (or use ↑/↓) in Manage Columns;
 *     `prefs.columns` is both the visible set and the order.
 *   - Phone cell lists Mobile 1 and Mobile 2, each with its own call icon →
 *     console opens that lead and places that call (`?dial=primary|alt`).
 */
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronRight, Columns3, Eye, GripVertical, ListOrdered, Pencil, Phone, RotateCcw, SlidersHorizontal, StretchHorizontal, Trash2 } from "lucide-react";
import { StageTag, Tag } from "@/components/ui/primitives";
import { SkeletonRows } from "@/components/ui/skeletons";
import { COLUMNS, SOURCE_LABEL, ago, age, relTime } from "@/components/leads/meta";
import { formatValue, type Person } from "@/components/leads/field-input";
import type { FieldDef } from "@/lib/leads/layout";
import type { LeadRow } from "@/lib/leads/list";

export const DEFAULT_WIDTH: Record<string, number> = {
  name: 220, phone: 170, email: 210, process: 150, source: 130, campaign: 150, stage: 110, owner: 150,
  outcome: 140, attempts: 90, callback: 130, activity: 120, city: 120, created: 80,
};

export interface GridPrefs {
  /** System column keys and custom-field columns (`cf:<key>`). */
  columns: string[];
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
  fieldColumns,
  fieldDefs = [],
  people = [],
}: {
  /** Setup → Lead layout: every visible field that can be a column, in layout order, with its label. */
  fieldColumns?: { key: string; label: string }[];
  fieldDefs?: FieldDef[];
  people?: Person[];
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
  const [dragKey, setDragKey] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Scroll position per list URL (page + filters), so coming back from a lead
  // lands on the same rows. Per-tab sessionStorage; a blocked store just means top.
  const scroller = useRef<HTMLDivElement>(null);
  const scrollKey = () => `leads-scroll:${window.location.search}`;
  useLayoutEffect(() => {
    try {
      const y = Number(sessionStorage.getItem(scrollKey()));
      if (y && scroller.current) scroller.current.scrollTop = y;
    } catch {}
  }, []);
  const { columns, widths, wrap } = prefs;
  const has = (k: string) => columns.includes(k);
  // Columns on offer = the lead layout's visible fields (system + custom) with their labels;
  // a field hidden in the layout drops out of the grid too.
  const available = fieldColumns ?? COLUMNS.map((c) => ({ key: c.key as string, label: c.label }));
  const LABEL: Record<string, string> = Object.fromEntries(available.map((c) => [c.key, c.label]));
  const defOf = new Map(fieldDefs.map((d) => [d.key, d]));
  const shownCols = columns.filter((k) => k in LABEL);
  // Manage Columns lists the visible ones in their order, then the hidden ones.
  const menuCols = [...shownCols, ...available.map((c) => c.key).filter((k) => !columns.includes(k))];
  const move = (k: string, to: number) => {
    const next = shownCols.filter((x) => x !== k);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, k);
    onPrefs({ ...prefs, columns: next });
  };
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
      <div
        ref={scroller}
        onScroll={(e) => {
          try {
            sessionStorage.setItem(scrollKey(), String(Math.round(e.currentTarget.scrollTop)));
          } catch {}
        }}
        aria-busy={pending}
        className="panel min-h-0 flex-1 overflow-auto overscroll-contain"
      >
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
              {shownCols.map((k) => th(k, LABEL[k] ?? k, k === "callback" || k === "created" || k === "attempts"))}
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
            {/* While a filter / sort / page change loads, skeleton rows hold the table's shape (header and pinned columns stay). */}
            {pending ? <SkeletonRows rows={Math.min(Math.max(rows.length, 8), 15)} cols={shownCols.length + (recycleBin ? 5 : 4)} /> : rows.map((l) => {
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
                  {shownCols.map((k) => {
                    switch (k) {
                      case "phone": {
                        const callable = !recycleBin && l.status === "open";
                        const num = (n: string, which: "primary" | "alt") =>
                          callable ? (
                            <Link key={which} href={`/console?lead=${l.id}&dial=${which}`} className="group/call inline-flex items-center gap-1.5 font-mono text-[12.5px] tnum hover:text-teal-ink" title={`Call ${n}`} aria-label={`Call ${l.name} on ${which === "alt" ? "Mobile 2" : "Mobile 1"}`}>
                              {n} <Phone size={12} className="text-ink-4 group-hover/call:text-teal-ink" />
                            </Link>
                          ) : (
                            <span key={which} className="font-mono text-[12.5px] tnum">{n}</span>
                          );
                        return (
                          <td key={k} {...cell("phone", bg)}>
                            <div className="flex flex-col gap-0.5">
                              {l.phone === "—" ? <span className="text-ink-4">—</span> : num(l.phone, "primary")}
                              {l.altPhone && num(l.altPhone, "alt")}
                            </div>
                          </td>
                        );
                      }
                      case "email":
                        return <td key={k} {...cell("email", `text-ink-2 ${bg}`)}>{l.email ?? <span className="text-ink-4">—</span>}</td>;
                      case "process":
                        return <td key={k} {...cell("process", `text-ink-2 ${bg}`)}>{l.processName}</td>;
                      case "source":
                        return <td key={k} {...cell("source", bg)}><Tag>{SOURCE_LABEL[l.source] ?? l.source}</Tag></td>;
                      case "campaign":
                        return <td key={k} {...cell("campaign", `text-ink-2 ${bg}`)}>{l.campaign ?? <span className="text-ink-4">—</span>}</td>;
                      case "stage":
                        return <td key={k} {...cell("stage", bg)}>{l.status === "open" ? <StageTag stage={l.stage} /> : <Tag tone={l.status === "won" ? "moss" : "ember"}>{l.status === "dnc" ? "DNC" : l.status[0]!.toUpperCase() + l.status.slice(1)}</Tag>}</td>;
                      case "owner":
                        return <td key={k} {...cell("owner", `text-ink-2 ${bg}`)}>{l.owner ?? <span className="text-ember-ink">Unassigned</span>}</td>;
                      case "outcome":
                        return <td key={k} {...cell("outcome", `text-ink-2 ${bg}`)}>{l.lastDisposition ?? <span className="text-ink-4">—</span>}</td>;
                      case "attempts":
                        return <td key={k} {...cell("attempts", `text-right font-mono text-[12px] tnum ${bg}`)}>{l.attempts}</td>;
                      case "callback":
                        return (
                          <td key={k} {...cell("callback", `text-right font-mono text-[12px] tnum ${overdue ? "font-semibold text-ember-ink" : "text-ink-2"} ${bg}`)}>
                            {l.nextCallbackAt ? relTime(l.nextCallbackAt, renderedAt) : <span className="text-ink-4">—</span>}
                          </td>
                        );
                      case "activity":
                        return <td key={k} {...cell("activity", `text-ink-3 ${bg}`)}>{l.lastActivityAt ? ago(l.lastActivityAt, renderedAt) : <span className="text-ink-4">—</span>}</td>;
                      case "city":
                        return <td key={k} {...cell("city", `text-ink-2 ${bg}`)}>{l.city ?? <span className="text-ink-4">—</span>}</td>;
                      case "created":
                        return <td key={k} {...cell("created", `text-right font-mono text-[12px] text-ink-3 tnum ${bg}`)}>{age(l.createdAt, renderedAt)}</td>;
                      default: {
                        // Custom field column (cf:<key>).
                        const v = formatValue(defOf.get(k.slice(3)), l.custom?.[k.slice(3)], people);
                        return <td key={k} {...cell(k, `text-ink-2 ${bg}`)}>{v || <span className="text-ink-4">—</span>}</td>;
                      }
                    }
                  })}
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
            {!pending && rows.length === 0 && (
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
            <div className="w-[250px] rounded-md border border-rule bg-sheet p-1.5 shadow-[0_14px_40px_-12px_rgba(21,23,28,0.3)]">
              {menu === "columns" && (
                <>
                  <div className="eyebrow px-2 pt-1">Manage columns</div>
                  <p className="px-2 pb-1.5 text-[11px] text-ink-4">Drag or use the arrows to change the order.</p>
                  <div className="max-h-[340px] overflow-y-auto">
                    {menuCols.map((k) => {
                      const on = has(k);
                      const i = shownCols.indexOf(k);
                      return (
                        <div
                          key={k}
                          draggable={on}
                          onDragStart={(e) => {
                            setDragKey(k);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragOver={(e) => {
                            if (!dragKey || !on || dragKey === k) return;
                            e.preventDefault();
                            move(dragKey, i);
                          }}
                          onDragEnd={() => setDragKey(null)}
                          data-col-item={k}
                          className={`group/item flex items-center gap-1.5 rounded px-1 py-1 text-[12.5px] hover:bg-paper ${dragKey === k ? "bg-teal/15" : ""}`}
                        >
                          <GripVertical size={13} className={on ? "cursor-grab text-ink-4 active:cursor-grabbing" : "invisible"} aria-hidden />
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={(e) => onPrefs({ ...prefs, columns: e.target.checked ? [...shownCols, k] : shownCols.filter((x) => x !== k) })}
                              className="h-3.5 w-3.5 accent-[var(--color-ink)]"
                            />
                            <span className="truncate">{LABEL[k]}</span>
                          </label>
                          {on && (
                            <span className="flex opacity-0 group-hover/item:opacity-100 focus-within:opacity-100">
                              <button onClick={() => move(k, i - 1)} disabled={i === 0} aria-label={`Move ${LABEL[k]} left`} title="Move left" className="rounded p-0.5 text-ink-3 hover:bg-sheet hover:text-ink disabled:opacity-30">
                                <ArrowUp size={12} />
                              </button>
                              <button onClick={() => move(k, i + 1)} disabled={i === shownCols.length - 1} aria-label={`Move ${LABEL[k]} right`} title="Move right" className="rounded p-0.5 text-ink-3 hover:bg-sheet hover:text-ink disabled:opacity-30">
                                <ArrowDown size={12} />
                              </button>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <button onClick={() => onPrefs({ ...prefs, columns: COLUMNS.filter((c) => c.default).map((c) => c.key) })} className="mt-1 w-full rounded px-2 py-1.5 text-left text-[12px] text-ink-3 hover:bg-paper hover:text-ink">
                    Default columns &amp; order
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
