"use client";

/**
 * One input + one display format per custom field type, shared by every lead
 * screen (Console details, lead page, Create Lead, Leads grid) so a field
 * behaves the same everywhere. Values travel as strings; the server
 * validates and coerces them (lib/admin/custom-fields.ts validateCustom).
 * Date+time is converted to an ISO instant in the browser, so the server
 * never guesses a timezone.
 */
import type { FieldDef } from "@/lib/leads/layout";

export type Person = { id: string; name: string };

const inputCls = "h-9 w-full rounded-md border border-rule bg-sheet px-3 text-[13px] outline-none focus:border-ink disabled:bg-paper disabled:text-ink-3";

/** ISO instant → value for <input type="datetime-local"> (browser time). */
const toLocalInput = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function FieldInput({
  def,
  value,
  onChange,
  people = [],
  disabled,
  autoFocus,
  onCommit,
  compact,
}: {
  def: FieldDef;
  value: string;
  onChange: (v: string) => void;
  people?: Person[];
  disabled?: boolean;
  autoFocus?: boolean;
  /** Console inline editing: Enter / blur saves. */
  onCommit?: (v?: string) => void;
  compact?: boolean;
}) {
  const cls = compact ? "h-8 w-full rounded border border-ink bg-sheet px-2 text-[13px] outline-none" : inputCls;
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && def.type !== "textarea") onCommit?.();
  };
  switch (def.type) {
    case "dropdown":
    case "boolean":
    case "user": {
      const opts = def.type === "boolean" ? [{ v: "yes", l: "Yes" }, { v: "no", l: "No" }] : def.type === "user" ? people.map((p) => ({ v: p.id, l: p.name })) : def.options.map((o) => ({ v: o, l: o }));
      const cur = def.type === "boolean" ? ({ true: "yes", false: "no" } as Record<string, string>)[value] ?? value : value;
      return (
        <select className={cls} value={cur} disabled={disabled} autoFocus={autoFocus} onChange={(e) => (onChange(e.target.value), onCommit?.(e.target.value))} onBlur={() => onCommit?.()}>
          <option value="">—</option>
          {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
      );
    }
    case "radio":
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 py-1.5" role="radiogroup" aria-label={def.label}>
          {def.options.map((o) => (
            <label key={o} className="inline-flex items-center gap-1.5 text-[13px]">
              <input type="radio" name={def.key} value={o} checked={value === o} disabled={disabled} onChange={() => (onChange(o), onCommit?.(o))} className="accent-[var(--color-ink)]" />
              {o}
            </label>
          ))}
          {value && !disabled && <button type="button" onClick={() => (onChange(""), onCommit?.(""))} className="text-[12px] text-ink-3 hover:text-ink">Clear</button>}
        </div>
      );
    case "multiselect": {
      const picked = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
      const toggle = (o: string) => {
        const next = new Set(picked);
        if (next.has(o)) next.delete(o);
        else next.add(o);
        const v = def.options.filter((x) => next.has(x)).join(", ");
        onChange(v);
        onCommit?.(v);
      };
      return (
        <div className="flex flex-wrap gap-1.5 py-1">
          {def.options.map((o) => (
            <button type="button" key={o} disabled={disabled} onClick={() => toggle(o)} className={`rounded-full border px-2.5 py-1 text-[12px] ${picked.has(o) ? "border-ink bg-ink text-sheet" : "border-rule text-ink-2 hover:border-ink-3"}`}>
              {o}
            </button>
          ))}
        </div>
      );
    }
    case "textarea":
      return (
        <textarea
          className={`${cls} h-auto min-h-[72px] py-2`}
          rows={3}
          maxLength={5000}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => onCommit?.()}
        />
      );
    case "datetime":
      return (
        <input
          type="datetime-local"
          className={cls}
          value={toLocalInput(value)}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : "")}
          onBlur={() => onCommit?.()}
          onKeyDown={keys}
        />
      );
    default: {
      const numeric = ["number", "decimal", "currency", "percent"].includes(def.type);
      const type = def.type === "date" ? "date" : def.type === "email" ? "email" : def.type === "url" ? "url" : def.type === "phone" ? "tel" : "text";
      const input = (
        <input
          type={type}
          inputMode={numeric ? "decimal" : def.type === "phone" ? "tel" : undefined}
          className={cls}
          value={def.type === "date" ? value.slice(0, 10) : value}
          disabled={disabled}
          autoFocus={autoFocus}
          maxLength={500}
          placeholder={def.type === "url" ? "https://…" : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => onCommit?.()}
          onKeyDown={keys}
        />
      );
      if (def.type !== "currency" && def.type !== "percent") return input;
      return (
        <div className="flex items-center gap-1.5">
          {def.type === "currency" && <span className="text-[13px] text-ink-3">₹</span>}
          {input}
          {def.type === "percent" && <span className="text-[13px] text-ink-3">%</span>}
        </div>
      );
    }
  }
}

/** A stored custom value → text for display. */
export function formatValue(def: Pick<FieldDef, "type"> | undefined, v: unknown, people: Person[] = [], timeZone?: string): string {
  if (v === undefined || v === null || v === "") return "";
  if (Array.isArray(v)) return v.join(", ");
  switch (def?.type) {
    case "boolean":
      return v === true || /^(true|yes)$/i.test(String(v)) ? "Yes" : "No";
    case "currency":
      return Number.isFinite(Number(v)) ? `₹${Number(v).toLocaleString("en-IN")}` : String(v);
    case "percent":
      return `${v}%`;
    case "decimal":
    case "number":
      return Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-IN") : String(v);
    case "date": {
      const t = Date.parse(String(v));
      return Number.isNaN(t) ? String(v) : new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    }
    case "datetime": {
      const t = Date.parse(String(v));
      return Number.isNaN(t) ? String(v) : new Date(t).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
    }
    case "user":
      return people.find((p) => p.id === v)?.name ?? "Unknown person";
    default:
      return String(v);
  }
}

/** A stored custom value → the string a form edits. */
export function toFormValue(def: Pick<FieldDef, "type">, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (def.type === "boolean") return v === true || /^(true|yes)$/i.test(String(v)) ? "yes" : v === false || /^(false|no)$/i.test(String(v)) ? "no" : "";
  return String(v);
}
