import { describe, expect, it } from "vitest";
import { clockOffset, handAngles } from "@/lib/time/clock";

const ist = (iso: string) => Date.parse(`${iso}+05:30`);

describe("handAngles (IST)", () => {
  it("12:00:00 → all hands up", () => {
    expect(handAngles(ist("2026-10-03T00:00:00"))).toEqual({ hour: 0, minute: 0, second: 0 });
    expect(handAngles(ist("2026-10-03T12:00:00"))).toEqual({ hour: 0, minute: 0, second: 0 });
  });
  it("3:00 → hour hand at 90°", () => {
    expect(handAngles(ist("2026-10-03T15:00:00")).hour).toBeCloseTo(90);
  });
  it("6:30:00 → hour halfway between 6 and 7, minute at 180°", () => {
    const a = handAngles(ist("2026-10-03T06:30:00"));
    expect(a.hour).toBeCloseTo(195);
    expect(a.minute).toBeCloseTo(180);
  });
  it("07:02:14.500 → minute includes seconds, second sweeps", () => {
    const a = handAngles(ist("2026-10-03T07:02:14.500"));
    expect(a.second).toBeCloseTo(87);
    expect(a.minute).toBeCloseTo(2 * 6 + 14.5 * 0.1);
    expect(a.hour).toBeCloseTo(7 * 30 + (2 + 14.5 / 60) * 0.5);
  });
  it("ticking mode drops the milliseconds", () => {
    expect(handAngles(ist("2026-10-03T07:02:14.900"), undefined, false).second).toBe(84);
  });
  it("is IST, not UTC", () => {
    expect(handAngles(Date.parse("2026-10-03T00:00:00Z")).hour).toBeCloseTo(165); // 05:30 IST
  });
});

describe("clockOffset", () => {
  it("adds half the round trip", () => {
    expect(clockOffset(10_000, 1_000, 1_200)).toBe(10_000 + 100 - 1_200);
  });
  it("ignores slow or nonsense samples", () => {
    expect(clockOffset(10_000, 0, 5_000)).toBe(0);
    expect(clockOffset(Number.NaN, 0, 10)).toBe(0);
    expect(clockOffset(10_000, 10, 0)).toBe(0);
  });
});
