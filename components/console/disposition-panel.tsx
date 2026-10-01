"use client";

/**
 * Wrap-up: outcome (keys 1–8), optional callback time, note, save.
 * Mirrors the rule "disposition required before the next call" (PRD FR-20).
 * Callback quick picks follow crmv7's popup (default time 11:45 AM).
 */
import { useEffect, useMemo, useState } from "react";
import { Check, CornerDownLeft } from "lucide-react";
import { Kbd } from "@/components/ui/primitives";
import { DISPOSITIONS, type Disposition } from "@/lib/ui/sample-data";

const CATEGORY_STYLE: Record<Disposition["category"], string> = {
  positive: "data-[on=true]:bg-teal data-[on=true]:text-ink data-[on=true]:ring-teal",
  converted: "data-[on=true]:bg-moss data-[on=true]:text-sheet data-[on=true]:ring-moss",
  callback: "data-[on=true]:bg-amber data-[on=true]:text-sheet data-[on=true]:ring-amber",
  neutral: "data-[on=true]:bg-ink data-[on=true]:text-sheet data-[on=true]:ring-ink",
  negative: "data-[on=true]:bg-ink-2 data-[on=true]:text-sheet data-[on=true]:ring-ink-2",
  dnc: "data-[on=true]:bg-ember data-[on=true]:text-sheet data-[on=true]:ring-ember",
};

const QUICK_PICKS = ["In 1 hour", "Today 6:00 PM", "Tomorrow 11:45 AM", "In 2 days 11:45 AM"];

export function DispositionPanel({ enabled, onSaved }: { enabled: boolean; onSaved: (label: string, when?: string) => void }) {
  // Remounted per lead by the parent (key={lead.id}), which resets the form.
  const [picked, setPicked] = useState<Disposition | null>(null);
  const [when, setWhen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);

  const needsTime = picked?.category === "callback";
  const canSave = enabled && !!picked && (!needsTime || !!when) && !saved;

  const save = useMemo(
    () => () => {
      if (!canSave || !picked) return;
      setSaved(true);
      onSaved(picked.label, needsTime ? (when ?? undefined) : undefined);
    },
    [canSave, picked, needsTime, when, onSaved],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!enabled || (e.target as HTMLElement).closest("input,textarea,select")) return;
      const d = DISPOSITIONS.find((x) => x.key === e.key);
      if (d) setPicked(d);
      if (e.key === "Enter") save();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, save]);

  return (
    <section className={`panel p-4 transition-opacity ${enabled ? "" : "opacity-55"}`} data-locked={!enabled}>
      <div className="mb-3 flex items-baseline justify-between">
        <div className="eyebrow">Outcome</div>
        <div className="text-[11.5px] text-ink-3">{enabled ? "Press 1–8, then Enter" : "Unlocks when the call ends"}</div>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {DISPOSITIONS.map((d) => (
          <button
            key={d.code}
            disabled={!enabled || saved}
            data-on={picked?.code === d.code}
            onClick={() => setPicked(d)}
            className={`flex h-10 items-center justify-between rounded-[5px] px-2.5 text-left text-[12.5px] font-medium text-ink-2 ring-1 ring-inset ring-rule transition hover:ring-ink-3 disabled:cursor-not-allowed ${CATEGORY_STYLE[d.category]}`}
          >
            {d.label}
            <span className="font-mono text-[10.5px] opacity-60">{d.key}</span>
          </button>
        ))}
      </div>

      {needsTime && (
        <div className="mt-3">
          <div className="eyebrow mb-1.5">Call back</div>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_PICKS.map((q) => (
              <button
                key={q}
                onClick={() => setWhen(q)}
                disabled={saved}
                className={`h-8 rounded-[5px] px-2.5 text-[12px] ring-1 ring-inset transition ${
                  when === q ? "bg-amber text-sheet ring-amber" : "text-ink-2 ring-rule hover:ring-ink-3"
                }`}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-end gap-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={!enabled || saved}
          placeholder="Note for the next call (optional)"
          rows={2}
          className="min-h-[44px] flex-1 resize-none rounded-[5px] border border-rule bg-sheet px-3 py-2 text-[13px] outline-none placeholder:text-ink-4 focus:border-ink disabled:bg-paper"
        />
        <button
          onClick={save}
          disabled={!canSave}
          className="inline-flex h-[44px] items-center gap-2 rounded-[5px] bg-ink px-4 text-[13px] font-semibold text-sheet transition hover:bg-ink-2 disabled:cursor-not-allowed disabled:bg-rule-strong disabled:text-ink-3"
        >
          {saved ? <Check size={16} /> : <CornerDownLeft size={15} />}
          {saved ? "Saved" : "Save"}
          {!saved && <Kbd>↵</Kbd>}
        </button>
      </div>
    </section>
  );
}
