/**
 * Hand-drawn SVG charts for the Floor view. No chart library: each chart
 * shows exactly one thing, labelled directly, in the brand's semantic
 * colours (teal = connected, ink = attempted, orange = drop-off / breach).
 */
import { CALLS_BY_HOUR, FUNNEL } from "@/lib/ui/sample-data";

/** Calls per hour: attempted (outline) behind connected (solid teal). */
export function CallsByHour({ currentHour = 16 }: { currentHour?: number }) {
  const W = 640;
  const H = 210;
  const padL = 34;
  const padB = 26;
  const max = Math.max(...CALLS_BY_HOUR.map((d) => d.attempted ?? 0));
  const step = (W - padL) / CALLS_BY_HOUR.length;
  const y = (v: number) => H - padB - (v / max) * (H - padB - 14);
  const ticks = [0, 50, 100];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Calls attempted and connected per hour today">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--color-rule)" strokeDasharray={t === 0 ? undefined : "2 4"} />
          <text x={padL - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--color-ink-4)" fontFamily="var(--font-mono)">
            {t}
          </text>
        </g>
      ))}
      {CALLS_BY_HOUR.map((d, i) => {
        const x = padL + i * step + step * 0.18;
        const w = step * 0.64;
        const future = d.attempted === null;
        const now = d.hour === currentHour;
        return (
          <g key={d.hour}>
            {future ? (
              <rect x={x} y={y(12)} width={w} height={y(0) - y(12)} fill="none" stroke="var(--color-rule-strong)" strokeDasharray="2 3" rx="2" />
            ) : (
              <>
                <rect x={x} y={y(d.attempted!)} width={w} height={y(0) - y(d.attempted!)} fill="none" stroke="var(--color-ink-3)" strokeWidth="1" rx="2" />
                <rect x={x + 3} y={y(d.connected)} width={w - 6} height={y(0) - y(d.connected)} fill={now ? "var(--color-teal)" : "var(--color-teal-ink)"} rx="1.5" />
              </>
            )}
            <text
              x={x + w / 2}
              y={H - 8}
              textAnchor="middle"
              fontSize="10.5"
              fill={now ? "var(--color-ink)" : "var(--color-ink-4)"}
              fontWeight={now ? 700 : 400}
              fontFamily="var(--font-mono)"
            >
              {String(d.hour).padStart(2, "0")}
            </text>
            {now && (
              <text x={x + w / 2} y={y(d.attempted!) - 7} textAnchor="middle" fontSize="10" fill="var(--color-ink-2)" fontFamily="var(--font-mono)">
                {d.connected}/{d.attempted}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Funnel as stepped bars, each as wide as its count vs the first stage, with drop-off between. */
export function Funnel() {
  const first = FUNNEL[0]!.count;
  return (
    <ol className="flex flex-col gap-2.5">
      {FUNNEL.map((f, i) => {
        const prev = i > 0 ? FUNNEL[i - 1]!.count : f.count;
        const kept = f.count / prev;
        return (
          <li key={f.stage} className="grid grid-cols-[92px_1fr_auto] items-center gap-3">
            <span className="text-[12.5px] text-ink-2">{f.stage}</span>
            <span className="relative h-6">
              <span
                className={`absolute inset-y-0 left-0 rounded-[3px] ${i === FUNNEL.length - 1 ? "bg-moss" : i === 0 ? "bg-ink" : "bg-ink-2"}`}
                style={{ width: `${Math.max((f.count / first) * 100, 1.5)}%` }}
              />
            </span>
            <span className="w-[86px] text-right font-mono text-[12px] tnum">
              <span className="font-semibold text-ink">{f.count}</span>
              {i > 0 && <span className={`ml-2 ${kept < 0.5 ? "text-ember-ink" : "text-ink-4"}`}>{Math.round(kept * 100)}%</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Capacity ring for an agent: open leads vs their cap. Full = orange. */
export function CapacityRing({ open, max }: { open: number; max: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const f = Math.min(open / max, 1);
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-label={`${open} of ${max} open leads`}>
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--color-rule)" strokeWidth="2.5" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke={f >= 1 ? "var(--color-ember)" : "var(--color-ink-2)"}
        strokeWidth="2.5"
        strokeDasharray={`${f * c} ${c}`}
        transform="rotate(-90 12 12)"
        strokeLinecap="round"
      />
    </svg>
  );
}
