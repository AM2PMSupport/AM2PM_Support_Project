/**
 * Assignment pick methods (DESIGN.md §4) — pure functions.
 *
 * Each method takes the ELIGIBLE agents (already filtered, see
 * eligibility.ts) plus the process's saved state, and returns an ordered list
 * of candidates plus the state to save if the first candidate is used. The
 * caller tries candidates in order inside a transaction (assign.ts), because
 * the top pick may fill up between our read and our write.
 *
 * No I/O here, so every method is unit-tested (tests/assignment.test.ts).
 */
import type { AssignmentMethod } from "@/lib/db/schema";

export interface Candidate {
  id: string;
  /** shareWeight from the roster (Percentage / Ratio). */
  weight: number;
  openLeads: number;
  dailyQuota?: number;
  skills: string[];
}

export interface PickState {
  seq: number;
  smoothWeights: Record<string, number>;
  dailyCounts: Record<string, number>;
}

export interface PickResult {
  /** Candidates in preference order; empty = nobody can take the lead. */
  order: string[];
  /** State after assigning to order[0]. */
  next: (chosen: string) => PickState;
}

/** Equal: rotate through agents in a stable order, starting after `seq`. */
export function pickEqual(cands: Candidate[], state: PickState): PickResult {
  const sorted = [...cands].sort((a, b) => a.id.localeCompare(b.id));
  if (!sorted.length) return { order: [], next: () => state };
  const start = state.seq % sorted.length;
  const order = [...sorted.slice(start), ...sorted.slice(0, start)].map((c) => c.id);
  return { order, next: () => ({ ...state, seq: state.seq + 1 }) };
}

/**
 * Smooth weighted round-robin (nginx's algorithm). Weights 50/30/20 produce
 * A B A C A B A … — interleaved, unlike crmv7's contiguous blocks where the
 * first agent received all of the freshest leads (MEMORIE.md decision log).
 *
 *   1. add each agent's weight to its running total
 *   2. pick the highest running total
 *   3. subtract the sum of all weights from the winner
 */
export function pickSmoothWeighted(cands: Candidate[], state: PickState): PickResult {
  const live = cands.filter((c) => c.weight > 0);
  const pool = live.length ? live : cands.map((c) => ({ ...c, weight: 1 })); // no weights set → equal
  if (!pool.length) return { order: [], next: () => state };

  const total = pool.reduce((s, c) => s + c.weight, 0);
  const running: Record<string, number> = {};
  for (const c of pool) running[c.id] = (state.smoothWeights[c.id] ?? 0) + c.weight;

  // Highest running weight first; ties broken by id for determinism.
  const order = [...pool]
    .sort((a, b) => (running[b.id] ?? 0) - (running[a.id] ?? 0) || a.id.localeCompare(b.id))
    .map((c) => c.id);

  return {
    order,
    next: (chosen) => {
      const smoothWeights: Record<string, number> = { ...running };
      smoothWeights[chosen] = (smoothWeights[chosen] ?? 0) - total;
      return { ...state, smoothWeights };
    },
  };
}

/** Number: fixed daily quota per agent; skip anyone who has reached it. */
export function pickNumber(cands: Candidate[], state: PickState): PickResult {
  const withRoom = cands.filter((c) => (c.dailyQuota ?? 0) > (state.dailyCounts[c.id] ?? 0));
  // Among agents with room, the one furthest from their quota goes first.
  const order = withRoom
    .sort(
      (a, b) =>
        (b.dailyQuota ?? 0) - (state.dailyCounts[b.id] ?? 0) - ((a.dailyQuota ?? 0) - (state.dailyCounts[a.id] ?? 0)) ||
        a.id.localeCompare(b.id),
    )
    .map((c) => c.id);
  return {
    order,
    next: (chosen) => ({
      ...state,
      dailyCounts: { ...state.dailyCounts, [chosen]: (state.dailyCounts[chosen] ?? 0) + 1 },
    }),
  };
}

/** Load-based: fewest open leads right now. */
export function pickLoad(cands: Candidate[], state: PickState): PickResult {
  const order = [...cands].sort((a, b) => a.openLeads - b.openLeads || a.id.localeCompare(b.id)).map((c) => c.id);
  return { order, next: () => state };
}

/**
 * Dispatch by method. "skill" filters by tags first (done in eligibility.ts)
 * and then rotates equally among the matches.
 */
export function pick(method: AssignmentMethod, cands: Candidate[], state: PickState): PickResult {
  switch (method) {
    case "equal":
    case "skill":
      return pickEqual(cands, state);
    case "percentage":
    case "ratio":
      return pickSmoothWeighted(cands, state);
    case "number":
      return pickNumber(cands, state);
    case "load":
      return pickLoad(cands, state);
  }
}

/** Every daily counter rolls over when the tenant-local day changes. */
export function rollDay(state: PickState & { day: string }, today: string): PickState & { day: string } {
  return state.day === today ? state : { ...state, day: today, dailyCounts: {} };
}
