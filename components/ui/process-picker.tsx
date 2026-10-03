"use client";

/**
 * Process filter (Leads toolbar + console queue): "All processes", one
 * process, or any combination. Empty selection = all. Each row has "only"
 * to jump straight to a single process.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Layers, Search } from "lucide-react";

export function ProcessPicker({
  processes,
  value,
  onChange,
  className = "",
}: {
  processes: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const chosen = processes.filter((p) => value.includes(p.id));
  const label = !chosen.length ? "All processes" : chosen.length === 1 ? chosen[0]!.name : `${chosen.length} processes`;
  const shown = processes.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (processes.length < 2) return null; // nothing to choose between

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={chosen.map((p) => p.name).join(", ") || "All processes"}
        className={`inline-flex h-9 w-full max-w-[240px] items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium ${chosen.length ? "border-ink bg-ink text-sheet" : "border-rule bg-sheet text-ink-2 hover:border-ink-3"}`}
      >
        <Layers size={14} className="shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown size={13} className="ml-auto shrink-0 opacity-70" />
      </button>
      {open && (
        <div role="listbox" aria-multiselectable className="absolute top-10 left-0 z-40 w-[280px] rounded-md border border-rule bg-sheet p-1.5 shadow-[0_14px_40px_-12px_rgba(21,23,28,0.3)]">
          {processes.length > 6 && (
            <label className="mb-1 flex h-8 items-center gap-2 rounded border border-rule px-2">
              <Search size={13} className="text-ink-4" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a process" className="w-full bg-transparent text-[12.5px] outline-none" />
            </label>
          )}
          <button onClick={() => onChange([])} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-paper">
            <span className="w-4">{!value.length && <Check size={14} />}</span>
            <span className="font-semibold">All processes</span>
          </button>
          <div className="my-1 border-t border-rule" />
          <div className="max-h-[300px] overflow-y-auto">
            {shown.map((p) => (
              <div key={p.id} className="group flex items-center rounded hover:bg-paper">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-[12.5px]">
                  <input type="checkbox" checked={value.includes(p.id)} onChange={() => toggle(p.id)} className="h-3.5 w-3.5 accent-[var(--color-ink)]" />
                  <span className="truncate">{p.name}</span>
                </label>
                <button onClick={() => (onChange([p.id]), setOpen(false))} className="px-2 text-[11.5px] text-teal-ink opacity-0 group-hover:opacity-100 hover:underline">
                  only
                </button>
              </div>
            ))}
            {!shown.length && <p className="px-2 py-2 text-[12px] text-ink-4">No process matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
