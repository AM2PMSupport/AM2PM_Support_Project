/**
 * SLA ring — the logo's clock arc reused as a data mark.
 * Shows how much of the waiting window has passed; turns orange when a
 * callback is overdue, teal while a fresh lead is still inside its window.
 */
export function SlaRing({ fraction, overdue, size = 30 }: { fraction: number; overdue?: boolean; size?: number }) {
  const r = 12;
  const c = 2 * Math.PI * r;
  const f = Math.max(0.04, Math.min(1, fraction));
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true" className="shrink-0">
      <circle cx="15" cy="15" r={r} fill="none" stroke="var(--color-rule)" strokeWidth="3" />
      <circle
        cx="15"
        cy="15"
        r={r}
        fill="none"
        stroke={overdue ? "var(--color-ember)" : "var(--color-teal)"}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${f * c} ${c}`}
        transform="rotate(-90 15 15)"
      />
      {overdue && <circle cx="15" cy="15" r="3" fill="var(--color-ember)" />}
    </svg>
  );
}
