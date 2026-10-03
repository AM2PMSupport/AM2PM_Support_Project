"use client";

/**
 * Applied filters as removable chips — shown on the page (Leads under the
 * toolbar, console under the queue search) so it's always clear what is
 * filtered, even when the filter panel / pop-up is closed.
 */
import { X } from "lucide-react";
import { FLAG_LABEL, SOURCE_LABEL } from "@/components/leads/meta";
import { NOT_FILTER, type FilterOptions } from "@/components/leads/filter-panel";

type Params = Record<string, string>;
interface Chip {
  id: string;
  label: string;
  patch: Params; // params to set to remove this chip
}

const span = (a?: string, b?: string) => (a && b ? `${a} – ${b}` : a ? `from ${a}` : b ? `until ${b}` : "");

export function appliedChips(params: Params, options: FilterOptions): Chip[] {
  const chips: Chip[] = [];
  const multi = (key: string, title: string, label: (v: string) => string = (v) => v) => {
    const vals = params[key] ? params[key]!.split(",").filter(Boolean) : [];
    for (const v of vals) chips.push({ id: `${key}:${v}`, label: `${title}: ${label(v)}`, patch: { [key]: vals.filter((x) => x !== v).join(",") } });
  };
  const flags = params.flag ? params.flag.split(",").filter(Boolean) : [];
  for (const f of flags) chips.push({ id: `flag:${f}`, label: FLAG_LABEL[f] ?? f, patch: { flag: flags.filter((x) => x !== f).join(",") } });
  if (params.status && params.status !== "open") chips.push({ id: "status", label: `Status: ${params.status === "deleted" ? "Recycle bin" : params.status}`, patch: { status: "" } });
  multi("stage", "Stage");
  multi("source", "Source", (v) => SOURCE_LABEL[v] ?? v);
  multi("campaign", "Campaign");
  multi("outcome", "Outcome");
  multi("owner", "Owner", (v) => (v === "none" ? "Unassigned" : (options.owners.find((o) => o.id === v)?.name ?? "someone")));
  if (params.created) chips.push({ id: "created", label: `Created: ${{ today: "today", "7d": "last 7 days", "30d": "last 30 days" }[params.created] ?? params.created}`, patch: { created: "" } });
  if (params.created_from || params.created_to) chips.push({ id: "created_r", label: `Created: ${span(params.created_from, params.created_to)}`, patch: { created_from: "", created_to: "" } });
  if (params.activity_from || params.activity_to) chips.push({ id: "activity", label: `Last activity: ${span(params.activity_from, params.activity_to)}`, patch: { activity_from: "", activity_to: "" } });
  if (params.callback_from || params.callback_to) chips.push({ id: "callback", label: `Next callback: ${span(params.callback_from, params.callback_to)}`, patch: { callback_from: "", callback_to: "" } });
  if (params.attempts_min || params.attempts_max) chips.push({ id: "attempts", label: `Attempts: ${span(params.attempts_min, params.attempts_max)}`, patch: { attempts_min: "", attempts_max: "" } });
  if (params.city) chips.push({ id: "city", label: `City contains “${params.city}”`, patch: { city: "" } });
  for (const [k, v] of Object.entries(params)) {
    if (!k.startsWith("cf_") || !v) continue;
    const f = options.fields?.find((x) => `cf_${x.key}` === k);
    const name = f?.label ?? k.slice(3).replace(/_/g, " ");
    const text = v.startsWith("~")
      ? `contains “${v.slice(1)}”`
      : v.startsWith("=")
        ? v.slice(1).split("|").join(", ")
        : v.startsWith("n:") || v.startsWith("d:")
          ? span(...(v.slice(2).split("..") as [string, string]))
          : v === "b:yes"
            ? "Yes"
            : v === "b:no"
              ? "No"
              : v;
    chips.push({ id: k, label: `${name}: ${text}`, patch: { [k]: "" } });
  }
  return chips;
}

export function AppliedFilters({ params, options, onChange, className = "" }: { params: Params; options: FilterOptions; onChange: (patch: Params) => void; className?: string }) {
  const chips = appliedChips(params, options);
  if (!chips.length) return null;
  const clearAll = Object.fromEntries(Object.keys(params).filter((k) => !NOT_FILTER.has(k)).map((k) => [k, ""]));
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`} aria-label="Applied filters">
      {chips.map((c) => (
        <span key={c.id} className="inline-flex h-6 max-w-[260px] items-center gap-1 rounded-full bg-teal/20 pr-1 pl-2.5 text-[11.5px] font-medium text-ink">
          <span className="truncate">{c.label}</span>
          <button onClick={() => onChange(c.patch)} aria-label={`Remove ${c.label}`} className="rounded-full p-0.5 hover:bg-ink/10">
            <X size={11} />
          </button>
        </span>
      ))}
      <button onClick={() => onChange(clearAll)} className="text-[11.5px] font-medium text-teal-ink hover:underline">
        Clear all
      </button>
    </div>
  );
}
