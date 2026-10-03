"use client";

/**
 * Lead filters — shared by the Leads rail (applies instantly) and the
 * console pop-up (draft → Apply). Sections: saved filters, system filters,
 * status, stage, source, campaign, last outcome, owner, attempts, city,
 * created / last activity / next callback date ranges, and every CUSTOM
 * FIELD by its type (text contains · dropdown any-of · number range · date
 * range · yes/no). Params are the Leads URL params (lib/leads/list.ts
 * LeadQuery + cf_* custom filters).
 */
import { useState } from "react";
import { Bookmark, ChevronDown, Plus, Search, Share2, X } from "lucide-react";
import { FLAG_LABEL, OWNER_FLAGS, SOURCE_LABEL } from "@/components/leads/meta";

export interface FilterField {
  key: string;
  label: string;
  type: string; // text | number | date | dropdown | multiselect | boolean | phone | email
  options: string[];
}
export interface FilterOptions {
  stages: { v: string; n: number }[];
  sources: { v: string; n: number }[];
  owners: { id: string; name: string; n: number }[];
  processes: { id: string; name: string; stages: string[] }[];
  campaigns?: { v: string; n: number }[];
  outcomes?: { v: string; n: number }[];
  fields?: FilterField[];
}
export interface SavedView {
  id: string;
  name: string;
  query: Record<string, string>;
  shared: boolean;
  mine: boolean;
}

type Params = Record<string, string>;

function Section({ title, children, open: initial = true, active = false }: { title: string; children: React.ReactNode; open?: boolean; active?: boolean }) {
  const [open, setOpen] = useState(initial || active);
  return (
    <div className="border-t border-rule py-3 first:border-t-0">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-1 text-[12px] font-semibold text-ink-2">
        <ChevronDown size={13} className={`transition ${open ? "" : "-rotate-90"}`} />
        {title}
        {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-teal-ink" aria-label="active" />}
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
      {n !== undefined && <span className="font-mono text-[11px] text-ink-4">{n}</span>}
    </label>
  );
}

/** Text/number/date box that applies on Enter or when leaving the box (not on every keystroke). */
function Commit({ value, onCommit, type = "text", placeholder }: { value: string; onCommit: (v: string) => void; type?: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <input
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft.trim())}
      onKeyDown={(e) => e.key === "Enter" && draft !== value && onCommit(draft.trim())}
      className="h-7 w-full min-w-0 rounded border border-rule bg-sheet px-2 text-[12px] outline-none focus:border-ink"
    />
  );
}

/** from..to inputs. */
function Range({ from, to, type, onChange, placeholders = ["From", "To"] }: { from: string; to: string; type: "date" | "number"; onChange: (from: string, to: string) => void; placeholders?: [string, string] }) {
  return (
    <div className="flex items-center gap-1.5 px-1">
      <Commit type={type} value={from} placeholder={placeholders[0]} onCommit={(v) => onChange(v, to)} />
      <span className="text-[11px] text-ink-4">to</span>
      <Commit type={type} value={to} placeholder={placeholders[1]} onCommit={(v) => onChange(from, v)} />
    </div>
  );
}

/** Params that are not filters (paging, sort, view, search box, process picker on top). */
export const NOT_FILTER = new Set(["sort", "view", "limit", "cursor", "before", "page", "q", "process"]);

export function FilterPanel({
  className = "",
  variant = "rail",
  params,
  options,
  views = [],
  showOwners,
  canShare = false,
  canSeeBin = false,
  onChange,
  onApplyView,
  onSaveView,
  onDeleteView,
}: {
  className?: string;
  /** rail = Leads side panel (saved filters + status); popover = console. */
  variant?: "rail" | "popover";
  params: Params;
  options: FilterOptions;
  views?: SavedView[];
  showOwners: boolean;
  canShare?: boolean;
  canSeeBin?: boolean;
  onChange: (next: Params) => void;
  onApplyView?: (v: SavedView) => void;
  onSaveView?: (name: string, shared: boolean) => Promise<string | null>;
  onDeleteView?: (id: string) => void;
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
  const active = Object.entries(params).some(([k, v]) => v && !NOT_FILTER.has(k) && !(k === "status" && v === "open"));
  const activeView = views.find((v) => Object.entries(v.query).every(([k, val]) => params[k] === val) && Object.keys(v.query).length > 0);
  const rail = variant === "rail";

  // Custom field params (cf_<key>).
  const cf = (key: string) => params[`cf_${key}`] ?? "";
  const setCf = (key: string, v: string) => onChange({ [`cf_${key}`]: v });
  const rangeOf = (v: string, prefix: string) => (v.startsWith(prefix) ? v.slice(prefix.length).split("..") : ["", ""]);

  return (
    <aside className={`w-[260px] shrink-0 flex-col gap-1 overflow-y-auto overscroll-contain rounded-md border border-rule bg-sheet p-3 ${className}`}>
      <label className="mb-1 flex h-8 shrink-0 items-center gap-2 rounded border border-rule bg-paper/60 px-2">
        <Search size={13} className="text-ink-4" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a filter" className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-ink-4" />
      </label>

      {rail && (
        <Section title={`Saved filters${views.length ? ` · ${views.length}` : ""}`}>
          {views.filter((v) => match(v.name)).map((v) => (
            <div key={v.id} className={`group flex items-center gap-2 rounded px-1.5 py-1 text-[12.5px] ${activeView?.id === v.id ? "bg-ink text-sheet" : "text-ink-2 hover:bg-paper"}`}>
              <button onClick={() => onApplyView?.(v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {v.shared ? <Share2 size={12} className="shrink-0 opacity-60" /> : <Bookmark size={12} className="shrink-0 opacity-60" />}
                <span className="truncate">{v.name}</span>
              </button>
              {v.mine && (
                <button onClick={() => onDeleteView?.(v.id)} aria-label={`Delete ${v.name}`} className="opacity-0 group-hover:opacity-60 hover:!opacity-100">
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
                const err = (await onSaveView?.(name, shared)) ?? null;
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
      )}

      <Section title="System filters" active={!!params.flag}>
        {Object.entries(FLAG_LABEL)
          .filter(([k, l]) => match(l) && (!OWNER_FLAGS.has(k) || showOwners))
          .map(([k, l]) => (
            <Check key={k} label={l} checked={list("flag").includes(k)} onChange={(on) => toggle("flag", k, on)} />
          ))}
      </Section>

      {rail && (
        <Section title="Status" active={!!params.status && params.status !== "open"}>
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
      )}

      {options.stages.length > 0 && (
        <Section title="Stage" active={!!params.stage}>
          {options.stages.filter((s) => match(s.v)).map((s) => (
            <Check key={s.v} label={s.v} n={s.n} checked={list("stage").includes(s.v)} onChange={(on) => toggle("stage", s.v, on)} />
          ))}
        </Section>
      )}

      {options.sources.length > 0 && (
        <Section title="Source" active={!!params.source}>
          {options.sources.filter((s) => match(SOURCE_LABEL[s.v] ?? s.v)).map((s) => (
            <Check key={s.v} label={SOURCE_LABEL[s.v] ?? s.v} n={s.n} checked={list("source").includes(s.v)} onChange={(on) => toggle("source", s.v, on)} />
          ))}
        </Section>
      )}

      {!!options.campaigns?.length && (
        <Section title="Campaign" open={false} active={!!params.campaign}>
          {options.campaigns.filter((c) => match(c.v)).map((c) => (
            <Check key={c.v} label={c.v} n={c.n} checked={list("campaign").includes(c.v)} onChange={(on) => toggle("campaign", c.v, on)} />
          ))}
        </Section>
      )}

      {!!options.outcomes?.length && (
        <Section title="Last outcome" open={false} active={!!params.outcome}>
          {options.outcomes.filter((c) => match(c.v)).map((c) => (
            <Check key={c.v} label={c.v} n={c.n} checked={list("outcome").includes(c.v)} onChange={(on) => toggle("outcome", c.v, on)} />
          ))}
        </Section>
      )}

      {showOwners && (
        <Section title="Lead owner" open={false} active={!!params.owner}>
          <Check label="Unassigned" checked={list("owner").includes("none")} onChange={(on) => toggle("owner", "none", on)} />
          {options.owners.filter((o) => match(o.name)).map((o) => (
            <Check key={o.id} label={o.name} n={o.n} checked={list("owner").includes(o.id)} onChange={(on) => toggle("owner", o.id, on)} />
          ))}
        </Section>
      )}

      {match("attempts calls") && (
        <Section title="Attempts" open={false} active={!!(params.attempts_min || params.attempts_max)}>
          <Range type="number" from={params.attempts_min ?? ""} to={params.attempts_max ?? ""} placeholders={["Min", "Max"]} onChange={(a, b) => onChange({ attempts_min: a, attempts_max: b })} />
        </Section>
      )}

      {match("city") && (
        <Section title="City" open={false} active={!!params.city}>
          <div className="px-1">
            <Commit value={params.city ?? ""} placeholder="Contains… (e.g. Pune)" onCommit={(v) => onChange({ city: v })} />
          </div>
        </Section>
      )}

      {match("created date") && (
        <Section title="Created" active={!!(params.created || params.created_from || params.created_to)}>
          <div className="flex flex-wrap gap-1 px-1">
            {[["", "Any time"], ["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]].map(([v, l]) => (
              <button
                key={v}
                onClick={() => onChange({ created: v!, created_from: "", created_to: "" })}
                className={`h-7 rounded px-2.5 text-[12px] font-medium ${(params.created ?? "") === v && !params.created_from && !params.created_to ? "bg-ink text-sheet" : "bg-paper text-ink-3 hover:text-ink"}`}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="mt-1.5">
            <Range type="date" from={params.created_from ?? ""} to={params.created_to ?? ""} onChange={(a, b) => onChange({ created_from: a, created_to: b, created: "" })} />
          </div>
        </Section>
      )}

      {match("last activity date") && (
        <Section title="Last activity" open={false} active={!!(params.activity_from || params.activity_to)}>
          <Range type="date" from={params.activity_from ?? ""} to={params.activity_to ?? ""} onChange={(a, b) => onChange({ activity_from: a, activity_to: b })} />
        </Section>
      )}

      {match("next callback date") && (
        <Section title="Next callback" open={false} active={!!(params.callback_from || params.callback_to)}>
          <Range type="date" from={params.callback_from ?? ""} to={params.callback_to ?? ""} onChange={(a, b) => onChange({ callback_from: a, callback_to: b })} />
        </Section>
      )}

      {/* Custom fields — one control per field, by its type */}
      {(options.fields ?? [])
        .filter((f) => match(f.label))
        .map((f) => {
          const v = cf(f.key);
          if (f.type === "dropdown" || f.type === "multiselect") {
            const chosen = v.startsWith("=") ? v.slice(1).split("|").filter(Boolean) : [];
            return (
              <Section key={f.key} title={f.label} open={false} active={!!v}>
                {f.options.map((o) => (
                  <Check
                    key={o}
                    label={o}
                    checked={chosen.includes(o)}
                    onChange={(on) => {
                      const next = on ? [...chosen, o] : chosen.filter((x) => x !== o);
                      setCf(f.key, next.length ? `=${next.join("|")}` : "");
                    }}
                  />
                ))}
              </Section>
            );
          }
          if (f.type === "number") {
            const [a = "", b = ""] = rangeOf(v, "n:");
            return (
              <Section key={f.key} title={f.label} open={false} active={!!v}>
                <Range type="number" from={a} to={b} placeholders={["Min", "Max"]} onChange={(x, y) => setCf(f.key, x || y ? `n:${x}..${y}` : "")} />
              </Section>
            );
          }
          if (f.type === "date") {
            const [a = "", b = ""] = rangeOf(v, "d:");
            return (
              <Section key={f.key} title={f.label} open={false} active={!!v}>
                <Range type="date" from={a} to={b} onChange={(x, y) => setCf(f.key, x || y ? `d:${x}..${y}` : "")} />
              </Section>
            );
          }
          if (f.type === "boolean") {
            return (
              <Section key={f.key} title={f.label} open={false} active={!!v}>
                <div className="flex gap-1 px-1">
                  {[["", "Any"], ["b:yes", "Yes"], ["b:no", "No"]].map(([val, l]) => (
                    <button key={l} onClick={() => setCf(f.key, val!)} className={`h-7 rounded px-2.5 text-[12px] font-medium ${v === val ? "bg-ink text-sheet" : "bg-paper text-ink-3 hover:text-ink"}`}>
                      {l}
                    </button>
                  ))}
                </div>
              </Section>
            );
          }
          return (
            <Section key={f.key} title={f.label} open={false} active={!!v}>
              <div className="px-1">
                <Commit value={v.startsWith("~") ? v.slice(1) : ""} placeholder="Contains…" onCommit={(x) => setCf(f.key, x ? `~${x}` : "")} />
              </div>
            </Section>
          );
        })}

      {active && (
        <button
          onClick={() => onChange(Object.fromEntries(Object.keys(params).filter((k) => !NOT_FILTER.has(k)).map((k) => [k, ""])))}
          className="mt-1 h-8 shrink-0 rounded border border-rule text-[12px] font-medium text-ink-3 hover:border-ink-3 hover:text-ink"
        >
          Clear all filters
        </button>
      )}
    </aside>
  );
}
