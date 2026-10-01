/**
 * Least-connections choice among database targets (ARCHITECTURE.md §10).
 *
 * Pure function — no I/O — so it is unit-tested directly.
 *
 * Load of a target = connections currently checked out + requests waiting
 * for one. The healthy target with the lowest load wins; ties go to the
 * target used least recently (`lastPicked`), which spreads equal load evenly
 * instead of always picking the first. Unhealthy targets (circuit open after
 * a connection error) are skipped; if none is healthy the caller falls back
 * to the primary.
 *
 * Note: this balances within ONE function instance (each instance has its
 * own pools). Across many Vercel instances the effect averages out, and Neon
 * replicas autoscale, so a global coordinator is not needed.
 */

export interface TargetLoad {
  /** Connections in use right now. */
  active: number;
  /** Requests queued waiting for a connection. */
  waiting: number;
  /** false while the circuit breaker is open for this target. */
  healthy: boolean;
  /** Monotonic counter of the last time this target was picked (0 = never). */
  lastPicked: number;
}

/** Index of the least-loaded healthy target, or -1 when none is healthy. */
export function pickLeastConnections(targets: readonly TargetLoad[]): number {
  let best = -1;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    if (!t.healthy) continue;
    if (best === -1) {
      best = i;
      continue;
    }
    const b = targets[best]!;
    const load = t.active + t.waiting;
    const bestLoad = b.active + b.waiting;
    if (load < bestLoad || (load === bestLoad && t.lastPicked < b.lastPicked)) best = i;
  }
  return best;
}
