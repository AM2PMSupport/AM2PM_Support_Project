"use client";

/**
 * Left filter rail (Zoho-style): saved filters, then system filters, status,
 * stage, source, owner, process and created date — each with counts where
 * they're cheap. Every change rewrites the URL; the server re-renders.
 */
import { useState } from "react";
import { Bookmark, ChevronDown, Plus, Search, Share2, X } from "lucide-react";
import { FLAG_LABEL, SOURCE_LABEL } from "@/components/leads/meta";

export interface FilterOptions {
  stages: { v: string; n: number }[];
  sources: { v: string; n: number }[];
  owners: { id: string; name: string; n: number }[];
  processes: { id: string; name: string; stages: string[] }[];
}
export interface SavedView {
  id: string;
  name: string;
  query: Record<string, string>;
  shared: boolean;
  mine: boolean;
}

type Params = Record<string, string>;

function Section({ title, children, open: initial = true }: { title: string; children: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="border-t border-rule py-3 first:border-t-0">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-1 text-[12px] font-semibold text-ink-2">
        <ChevronDown size={13} className={`transition ${open ? "" : "-rotate-90"}`} />
        {title}
      </button>
      {open && <div className="mt-2 flex flex-col gap-0.5">{children}</div>}
    </div>
  );
}

function Check({ label, n, checked, onChange }: { label: string; n?: number; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px] text-ink-2 hover:bg-paper">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-ink)]" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {n !== undefined && <span className="font-mono text-[11px] text-ink-4 tnum">{n}</span>}
    </label>
  );
}

export function FilterPanel({
  params,
  options,
  views,
  showOwners,
  canShare,
  canSeeBin,
  onChange,
  onApplyView,
  onSaveView,
  onDeleteView,
}: {
  params: Params;
  options: FilterOptions;
  views: SavedView[];
  showOwners: boolean;
  canShare: boolean;
  canSeeBin: boolean;
  onChange: (next: Params) => void;
  onApplyView: (v: SavedView) => void;
  onSaveView: (name: string, shared: boolean) => Promise<string | null>;
  onDeleteView: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const list = (k: string) => (params[k] ? params[k]!.split(",") : []);
  const toggle = (k: string, v: string, on: boolean) => {
    const cur = new Set(list(k));
    if (on) cur.add(v);
    else cur.delete(v);
    onChange({ [k]: [...cur].join(",") });
  };
  const match = (label: string) => !q || label.toLowerCase().includes(q.toLowerCase());
  const active = ["flag", "stage", "source", "owner", "process", "created"].some((k) => params[k]) || (params.status && params.status !== "open");
  const activeView = views.find((v) => Object.entries(v.query).every(([k, val]) => params[k] === val) && Object.keys(v.query).length > 0);

  return (
    <aside className="flex w-[260px] shrink-0 flex-col gap-1 self-start rounded-md border border-rule bg-sheet p-3">
      <label className="mb-1 flex h-8 items-center gap-2 rounded border border-rule bg-paper/60 px-2">
        <Search size={13} className="text-ink-4" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a filter" className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-ink-4" />
      </label>

      <Section title={`Saved filters${views.length ? ` · ${views.length}` : ""}`}>
        {views.filter((v) => match(v.name)).map((v) => (
          <div key={v.id} className={`group flex items-center gap-2 rounded px-1.5 py-1 text-[12.5px] ${activeView?.id === v.id ? "bg-ink text-sheet" : "text-ink-2 hover:bg-paper"}`}>
            <button onClick={() => onApplyView(v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              {v.shared ? <Share2 size={12} className="shrink-0 opacity-60" /> : <Bookmark size={12} className="shrink-0 opacity-60" />}
              <span className="truncate">{v.name}</span>
            </button>
            {v.mine && (
              <button onClick={() => onDeleteView(v.id)} aria-label={`Delete ${v.name}`} className="opacity-0 group-hover:opacity-60 hover:!opacity-100">
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        {!views.length && <p className="px-1.5 text-[11.5px] text-ink-4">Set filters, then save them here.</p>}
        {naming ? (
          <form
            className="mt-1 flex flex-col gap-1.5 px-1"
            onSubmit={async (e) => {
              e.preventDefault();
              const err = await onSaveView(name, shared);
              if (err) setSaveError(err);
              else {
                setNaming(false);
                setName("");
                setShared(false);
                setSaveError(null);
              }
            }}
          >
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Filter name" maxLength={40} className="h-7 rounded border border-rule px-2 text-[12.5px] outline-none focus:border-ink" />
            {canShare && (
              <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="accent-[var(--color-ink)]" /> Share with everyone
              </label>
            )}
            {saveError && <span className="text-[11.5px] text-ember-ink">{saveError}</span>}
            <div className="flex gap-1.5">
              <button disabled={!name.trim()} className="h-7 flex-1 rounded bg-ink text-[12px] font-semibold text-sheet disabled:bg-ink-4">Save</button>
              <button type="button" onClick={() => setNaming(false)} className="h-7 rounded px-2 text-[12px] text-ink-3 hover:text-ink">Cancel</button>
            </div>
          </form>
        ) : (
          active && (
            <button onClick={() => setNaming(true)} className="mt-1 flex items-center gap-1.5 px-1.5 text-[12px] font-medium text-teal-ink hover:underline">
              <Plus size={12} /> Save current filter
            </button>
          )
        )}
      </Section>

      <Section title="System filters">
        {Object.entries(FLAG_LABEL)
          .filter(([k, l]) => match(l) && (k !== "mine" || showOwners))
          .map(([k, l]) => (
            <Check key={k} label={l} checked={list("flag").includes(k)} onChange={(on) => toggle("flag", k, on)} />
          ))}
      </Section>

      <Section title="Status">
        <div className="flex flex-wrap gap-1 px-1">
          {["open", "won", "lost", "dnc", "all", ...(canSeeBin ? ["deleted"] : [])].map((s) => (
            <button
              key={s}
              onClick={() => onChange({ status: s === "open" ? "" : s })}
              className={`h-7 rounded px-2.5 text-[12px] font-medium ${(params.status || "open") === s ? "bg-ink text-sheet" : "bg-paper text-ink-3 hover:text-ink"}`}
            >
              {s === "dnc" ? "DNC" : s === "deleted" ? "Recycle bin" : s[0]!.toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </Section>

      {options.stages.length > 0 && (
        <Section title="Stage">
          {options.stages.filter((s) => match(s.v)).map((s) => (
            <Check key={s.v} label={s.v} n={s.n} checked={list("stage").includes(s.v)} onChange={(on) => toggle("stage", s.v, on)} />
          ))}
        </Section>
      )}

      {options.sources.length > 0 && (
        <Section title="Source">
          {options.sources.filter((s) => match(SOURCE_LABEL[s.v] ?? s.v)).map((s) => (
            <Check key={s.v} label={SOURCE_LABEL[s.v] ?? s.v} n={s.n} checked={list("source").includes(s.v)} onChange={(on) => toggle("source", s.v, on)} />
          ))}
        </Section>
      )}

      {showOwners && (
        <Section title="Lead owner" open={false}>
          <Check label="Unassigned" checked={list("owner").includes("none")} onChange={(on) => toggle("owner", "none", on)} />
          {options.owners.filter((o) => match(o.name)).map((o) => (
            <Check key={o.id} label={o.name} n={o.n} checked={list("owner").includes(o.id)} onChange={(on) => toggle("owner", o.id, on)} />
          ))}
        </Section>
      )}

      {options.processes.length > 1 && (
        <Section title="Process" open={false}>
          {options.processes.filter((p) => match(p.name)).map((p) => (
            <Check key={p.id} label={p.name} checked={list("process").includes(p.id)} onChange={(on) => toggle("process", p.id, on)} />
          ))}
        </Section>
      )}

      <Section title="Created">
        <div className="flex flex-wrap gap-1 px-1">
          {[["", "Any time"], ["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]].map(([v, l]) => (
            <button key={v} onClick={() => onChange({ created: v! })} className={`h-7 rounded px-2.5 text-[12px] font-medium ${(params.created ?? "") === v ? "bg-ink text-sheet" : "bg-paper text-ink-3 hover:text-ink"}`}>
              {l}
            </button>
          ))}
        </div>
      </Section>

      {active && (
        <button onClick={() => onChange({ flag: "", stage: "", source: "", owner: "", process: "", created: "", status: "" })} className="mt-1 h-8 rounded border border-rule text-[12px] font-medium text-ink-3 hover:border-ink-3 hover:text-ink">
          Clear all filters
        </button>
      )}
    </aside>
  );
}
