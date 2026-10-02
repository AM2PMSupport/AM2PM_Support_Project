"use client";

/**
 * Form building blocks in the app's style: label above, hairline inputs,
 * errors in the orange "attention" tone, one-time secrets in a copy box.
 */
import { useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";

export function Field({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[11.5px] font-medium text-ink-3">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-ink-4">{hint}</span>}
    </label>
  );
}

const control =
  "h-9 w-full rounded-[5px] border border-rule bg-sheet px-2.5 text-[13px] text-ink outline-none transition placeholder:text-ink-4 focus:border-ink disabled:bg-paper";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${control} ${props.className ?? ""}`} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select {...props} className={`${control} ${props.className ?? ""}`}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-[12.5px] text-ink-2"
    >
      <span className={`relative h-[18px] w-[32px] rounded-full transition ${checked ? "bg-ink" : "bg-rule-strong"}`}>
        <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-sheet transition-all ${checked ? "left-[16px]" : "left-[2px]"}`} />
      </span>
      {label}
    </button>
  );
}

/** Multi-pick chips (days, processes, skills). */
export function ChipPicker<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={`h-8 rounded-[5px] px-2.5 text-[12px] ring-1 ring-inset transition ${on ? "bg-ink text-sheet ring-ink" : "text-ink-2 ring-rule hover:ring-ink-3"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Submit({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="inline-flex h-9 items-center gap-2 rounded-[5px] bg-ink px-4 text-[13px] font-semibold text-sheet transition hover:bg-ink-2 disabled:cursor-wait disabled:bg-ink-3"
    >
      {busy ? "Saving…" : children}
    </button>
  );
}

export function GhostButton({ children, onClick, danger, disabled }: { children: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] font-medium ring-1 ring-inset transition disabled:opacity-50 ${
        danger ? "text-ember-ink ring-ember/40 hover:bg-ember-wash" : "text-ink-2 ring-rule hover:ring-ink-3"
      }`}
    >
      {children}
    </button>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border-l-[3px] border-ember bg-ember-wash px-3 py-2 text-[12.5px] text-ember-ink">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" />
      {message}
    </p>
  );
}

/** A secret shown exactly once (new password, source key, webhook URL). */
export function SecretOnce({ label, value, onDone }: { label: string; value: string; onDone?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-dashed border-amber bg-amber-wash p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] font-semibold text-amber">{label} — shown only once. Copy it now.</span>
        {onDone && (
          <button type="button" onClick={onDone} className="text-[11.5px] text-ink-3 underline-offset-2 hover:underline">
            Done
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-[4px] bg-sheet px-2 py-1.5 font-mono text-[12.5px] text-ink">{value}</code>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
          className="inline-flex h-8 items-center gap-1 rounded-[5px] bg-ink px-2.5 text-[12px] font-semibold text-sheet"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
