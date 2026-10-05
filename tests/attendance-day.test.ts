import { describe, expect, it } from "vitest";
import { computeDay, IDLE_MS, mismatches, onLeave, presenceOf, shownPresence, STALE_MS } from "@/lib/attendance/day";

const h = 3_600_000;
const m = 60_000;

describe("computeDay", () => {
  it("work and breaks between clock events", () => {
    // 09:00 in, 13:00 break, 13:30 back, 18:00 out
    const d = computeDay([
      { type: "Out", at: 18 * h },
      { type: "In", at: 9 * h },
      { type: "StartBreak", at: 13 * h },
      { type: "In", at: 13 * h + 30 * m },
    ]);
    expect(d).toEqual({ firstIn: 9 * h, lastOut: 18 * h, workedSec: 8.5 * 3600, breakSec: 1800, open: false });
  });

  it("still clocked in counts up to now only when asked", () => {
    expect(computeDay([{ type: "In", at: 9 * h }], 11 * h)).toMatchObject({ workedSec: 7200, open: true, lastOut: null });
    expect(computeDay([{ type: "In", at: 9 * h }]).workedSec).toBe(0); // past day without an Out: not guessed
    expect(computeDay([])).toEqual({ firstIn: null, lastOut: null, workedSec: 0, breakSec: 0, open: false });
  });
});

describe("presence", () => {
  it("maps clock types and treats a stale sync as unknown", () => {
    expect([presenceOf("In"), presenceOf("StartBreak"), presenceOf("Out"), presenceOf("x")]).toEqual(["in", "break", "out", null]);
    expect(shownPresence("in", 0, STALE_MS - 1)).toBe("in");
    expect(shownPresence("in", 0, STALE_MS + 1)).toBe("unknown");
    expect(shownPresence(null, 0, 1)).toBe("out"); // synced, no event = not clocked in
    expect(shownPresence("in", null, 1)).toBe("unknown");
  });
});

describe("mismatches", () => {
  const now = 12 * h;
  it("flags calls while out, calls on a break, idle while in", () => {
    expect(mismatches({ presence: "out", stateAt: 8 * h, lastCallAt: now - 5 * m, takesCalls: true }, now)).toEqual(["calls_not_clocked_in"]);
    expect(mismatches({ presence: "break", stateAt: now - 20 * m, lastCallAt: now - 10 * m, takesCalls: true }, now)).toEqual(["calls_on_break"]);
    expect(mismatches({ presence: "in", stateAt: now - 2 * h, lastCallAt: now - IDLE_MS - m, takesCalls: true }, now)).toEqual(["idle_clocked_in"]);
    expect(mismatches({ presence: "in", stateAt: now - 2 * h, lastCallAt: now - 5 * m, takesCalls: true }, now)).toEqual([]);
  });
  it("never alerts on unknown presence or for people who don't take calls", () => {
    expect(mismatches({ presence: "unknown", stateAt: null, lastCallAt: now, takesCalls: true }, now)).toEqual([]);
    expect(mismatches({ presence: "out", stateAt: null, lastCallAt: now, takesCalls: false }, now)).toEqual([]);
  });
});

describe("onLeave", () => {
  it("approved leave covering the day", () => {
    const leaves = [{ startDate: "2026-10-05", endDate: "2026-10-07", status: "Approved" }, { startDate: "2026-10-10", endDate: "2026-10-10", status: "Pending" }];
    expect(onLeave(leaves, "2026-10-06")).toBe(true);
    expect(onLeave(leaves, "2026-10-08")).toBe(false);
    expect(onLeave(leaves, "2026-10-10")).toBe(false);
  });
});
