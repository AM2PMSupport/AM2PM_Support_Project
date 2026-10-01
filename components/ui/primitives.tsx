/**
 * Small shared UI pieces. Hand-built on purpose (no component kit) so the
 * product has its own look: hairline borders, tight radii, mono numbers.
 */
import type { ReactNode } from "react";

type Tone = "ink" | "teal" | "ember" | "moss" | "amber" | "muted";

const TONE: Record<Tone, string> = {
  ink: "bg-ink text-sheet",
  teal: "bg-teal-wash text-teal-ink",
  ember: "bg-ember-wash text-ember-ink",
  moss: "bg-moss-wash text-moss",
  amber: "bg-amber-wash text-amber",
  muted: "bg-paper text-ink-2 ring-1 ring-inset ring-rule",
};

export function Tag({ tone = "muted", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex h-[20px] items-center gap-1 rounded-sm px-1.5 text-[11px] font-semibold ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] border border-rule-strong bg-sheet px-1 font-mono text-[10.5px] text-ink-3">
      {children}
    </kbd>
  );
}

export function Avatar({ initials, tone = "ink", size = 28 }: { initials: string; tone?: "ink" | "teal" | "ember"; size?: number }) {
  const bg = tone === "teal" ? "bg-teal text-ink" : tone === "ember" ? "bg-ember text-sheet" : "bg-ink text-sheet";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${bg}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </span>
  );
}

/** Stage colour coding used everywhere a stage appears. */
export function StageTag({ stage }: { stage: string }) {
  const tone: Tone = stage === "Hot" ? "ember" : stage === "Warm" ? "amber" : stage === "Won" ? "moss" : stage === "New" ? "teal" : "muted";
  return <Tag tone={tone}>{stage}</Tag>;
}

export function SectionTitle({ eyebrow, title, right }: { eyebrow?: string; title: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
      </div>
      {right}
    </div>
  );
}
