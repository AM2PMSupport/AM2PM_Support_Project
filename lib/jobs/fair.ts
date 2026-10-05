/**
 * Fairness helpers for platform-wide background work (200–300 clients on one
 * 60 s function). Pure — no I/O — and unit-tested (tests/fair.test.ts).
 *
 *   rotate()      start the client list after the one the last run reached,
 *                 so a run that runs out of time continues next time instead
 *                 of always serving the same first clients
 *   capPerTenant  keep at most N items per client, in order, so one client's
 *                 backlog can't fill a whole batch and starve the rest
 */

/** `items` re-ordered to start just after `after` (wrapping); unchanged when `after` is unknown. */
export function rotate<T extends string>(items: readonly T[], after: string | null | undefined): T[] {
  const i = after ? items.indexOf(after as T) : -1;
  return i < 0 ? [...items] : [...items.slice(i + 1), ...items.slice(0, i + 1)];
}

/** First `cap` items per tenant, keeping the original order. */
export function capPerTenant<T extends { tenantId: string }>(items: readonly T[], cap: number): T[] {
  const seen = new Map<string, number>();
  return items.filter((it) => {
    const n = seen.get(it.tenantId) ?? 0;
    seen.set(it.tenantId, n + 1);
    return n < cap;
  });
}
