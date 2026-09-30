import { describe, expect, it } from "vitest";
import { pickEqual, pickLoad, pickNumber, pickSmoothWeighted, rollDay, type Candidate, type PickState } from "@/lib/assignment/methods";
import { eligibleUsers, withinWorkingHours } from "@/lib/assignment/eligibility";

const empty: PickState = { seq: 0, smoothWeights: {}, dailyCounts: {} };
const cand = (id: string, extra: Partial<Candidate> = {}): Candidate => ({ id, weight: 1, openLeads: 0, skills: [], ...extra });

/** Run a method N times, applying its state each time, and return the picks. */
function run(method: typeof pickEqual, cands: Candidate[], n: number): string[] {
  let state = empty;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = method(cands, state);
    const chosen = r.order[0]!;
    out.push(chosen);
    state = r.next(chosen);
  }
  return out;
}

describe("assignment methods", () => {
  it("equal rotates through agents", () => {
    expect(run(pickEqual, [cand("a"), cand("b"), cand("c")], 6)).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("smooth weighted round-robin interleaves 50/30/20 (not contiguous blocks)", () => {
    const picks = run(pickSmoothWeighted, [cand("a", { weight: 50 }), cand("b", { weight: 30 }), cand("c", { weight: 20 })], 10);
    expect(picks.filter((p) => p === "a")).toHaveLength(5);
    expect(picks.filter((p) => p === "b")).toHaveLength(3);
    expect(picks.filter((p) => p === "c")).toHaveLength(2);
    // Interleaved: "a" never gets more than 2 in a row.
    expect(picks.join("")).not.toMatch(/aaa/);
  });

  it("smooth weighted falls back to equal when no weights are set", () => {
    expect(run(pickSmoothWeighted, [cand("a", { weight: 0 }), cand("b", { weight: 0 })], 4).sort()).toEqual(["a", "a", "b", "b"]);
  });

  it("number respects daily quotas and stops when all are full", () => {
    const cands = [cand("a", { dailyQuota: 2 }), cand("b", { dailyQuota: 1 })];
    const picks = run(pickNumber, cands, 3);
    expect(picks.sort()).toEqual(["a", "a", "b"]);
    const full = pickNumber(cands, { ...empty, dailyCounts: { a: 2, b: 1 } });
    expect(full.order).toEqual([]);
  });

  it("load picks the agent with the fewest open leads", () => {
    expect(pickLoad([cand("a", { openLeads: 5 }), cand("b", { openLeads: 2 })], empty).order[0]).toBe("b");
  });

  it("rollDay clears daily counts on a new tenant-local day", () => {
    const s = { ...empty, day: "2026-10-01", dailyCounts: { a: 3 } };
    expect(rollDay(s, "2026-10-01").dailyCounts).toEqual({ a: 3 });
    expect(rollDay(s, "2026-10-02").dailyCounts).toEqual({});
  });
});

describe("eligibility", () => {
  let n = 0;
  const user = (over: Record<string, unknown> = {}) => ({
    id: `u${++n}`,
    status: "active" as const,
    isAvailable: true,
    openLeads: 0,
    maxOpenLeads: 10,
    dailyQuota: null as number | null,
    skills: [] as string[],
    ...over,
  });
  const assignment = (over: Record<string, unknown> = {}) => ({ method: "equal" as const, sticky: false, slaMinutes: 15, ...over });
  const base = { dailyCounts: {}, now: new Date("2026-10-01T06:00:00Z"), timeZone: "Asia/Kolkata" };

  it("filters inactive, unavailable and full agents (process mapping is the SQL join)", () => {
    const ok = user();
    const users = [ok, user({ status: "inactive" }), user({ isAvailable: false }), user({ openLeads: 10 })];
    expect(eligibleUsers({ ...base, assignment: assignment(), users }).map((u) => u.id)).toEqual([ok.id]);
  });

  it("respects the optional agent pool", () => {
    const a = user();
    const b = user();
    expect(eligibleUsers({ ...base, assignment: assignment({ pool: [b.id] }), users: [a, b] })).toEqual([b]);
  });

  it("number method skips agents at their daily quota", () => {
    const a = user({ dailyQuota: 2 });
    const b = user({ dailyQuota: 2 });
    const res = eligibleUsers({ ...base, assignment: assignment({ method: "number" }), users: [a, b], dailyCounts: { [a.id]: 2 } });
    expect(res).toEqual([b]);
  });

  it("skill method requires every tag", () => {
    const hindi = user({ skills: ["hindi", "pune"] });
    const users = [hindi, user({ skills: ["english"] })];
    const res = eligibleUsers({ ...base, assignment: assignment({ method: "skill" }), users, requiredSkills: ["hindi"] });
    expect(res).toEqual([hindi]);
  });

  it("working hours use the tenant timezone", () => {
    const hours = { days: [1, 2, 3, 4, 5], start: "09:30", end: "18:30" };
    // 2026-10-01 is a Thursday. 06:00 UTC = 11:30 IST → open; 14:00 UTC = 19:30 IST → closed.
    expect(withinWorkingHours(hours, new Date("2026-10-01T06:00:00Z"), "Asia/Kolkata")).toBe(true);
    expect(withinWorkingHours(hours, new Date("2026-10-01T14:00:00Z"), "Asia/Kolkata")).toBe(false);
    expect(withinWorkingHours(hours, new Date("2026-10-04T06:00:00Z"), "Asia/Kolkata")).toBe(false); // Sunday
  });
});
