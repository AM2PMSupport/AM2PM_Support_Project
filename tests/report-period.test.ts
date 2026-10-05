import { describe, expect, it } from "vitest";
import { activeSecOf, clockOf, daysOf, duration, localToday, MAX_DAYS, perHour, resolveRange, summariseAgents, type AgentDay } from "@/lib/reports/period";

const T = "2026-10-05";

describe("resolveRange", () => {
  it("presets are tenant-local, inclusive", () => {
    expect(resolveRange({ period: "today" }, T)).toMatchObject({ from: T, to: T, days: 1 });
    expect(resolveRange({ period: "yesterday" }, T)).toMatchObject({ from: "2026-10-04", to: "2026-10-04", days: 1 });
    expect(resolveRange({ period: "7d" }, T)).toMatchObject({ from: "2026-09-29", to: T, days: 7 });
    expect(resolveRange({ period: "this_month" }, T)).toMatchObject({ from: "2026-10-01", to: T, days: 5 });
    expect(resolveRange({ period: "last_month" }, T)).toMatchObject({ from: "2026-09-01", to: "2026-09-30", days: 30 });
    expect(resolveRange({ period: "last_month" }, "2026-03-15")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("unknown or garbage input falls back safely", () => {
    expect(resolveRange({ period: "drop table" }, T).period).toBe("7d");
    expect(resolveRange({ period: "custom", from: "2026-02-31", to: "x" }, T)).toMatchObject({ from: "2026-09-29", to: T });
  });

  it("custom ranges are swapped, never in the future, and capped", () => {
    expect(resolveRange({ period: "custom", from: "2026-10-03", to: "2026-10-01" }, T)).toMatchObject({ from: "2026-10-01", to: "2026-10-03", days: 3 });
    expect(resolveRange({ period: "custom", from: "2026-10-01", to: "2027-01-01" }, T).to).toBe(T);
    expect(resolveRange({ period: "custom", from: "2025-01-01", to: T }, T).days).toBe(MAX_DAYS);
  });

  it("lists every day and finds today in a timezone", () => {
    expect(daysOf({ from: "2026-09-29", to: "2026-10-01" })).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
    // 2026-10-04 20:00 UTC is already the 5th in India.
    expect(localToday("Asia/Kolkata", new Date("2026-10-04T20:00:00Z"))).toBe("2026-10-05");
  });
});

describe("agent maths", () => {
  const day = (p: Partial<AgentDay>): AgentDay => ({
    agentId: "a", name: "Asha", day: T, login: null, logout: null, firstCall: null, lastCall: null, firstCallMin: null, lastCallMin: null,
    dialled: 0, connected: 0, inboundAnswered: 0, inboundMissed: 0, talkSec: 0, interested: 0, callbacksSet: 0, notInterested: 0, won: 0, callbacksDue: 0, callbacksOnTime: 0, ...p,
  });
  const h = 3_600_000;

  it("per hour uses the working span, at least one hour", () => {
    expect(perHour(5, 600)).toBe(5);
    expect(perHour(40, 4 * 3600)).toBe(10);
    expect(perHour(0, 3600)).toBeNull();
    expect(activeSecOf({ firstCall: 0, lastCall: 2 * h })).toBe(7200);
  });

  it("summarises days per agent", () => {
    const [s] = summariseAgents([
      day({ day: "2026-10-04", firstCall: 0, lastCall: 4 * h, firstCallMin: 9 * 60 + 30, lastCallMin: 13 * 60 + 30, dialled: 40, connected: 20, talkSec: 3000, won: 2, callbacksDue: 4, callbacksOnTime: 3 }),
      day({ day: T, firstCall: 0, lastCall: 6 * h, firstCallMin: 10 * 60 + 30, lastCallMin: 16 * 60 + 30, dialled: 60, connected: 30, talkSec: 4500, won: 3, callbacksDue: 1, callbacksOnTime: 1 }),
    ]);
    expect(s).toMatchObject({ daysActive: 2, dialled: 100, connected: 50, connectRate: 0.5, won: 5, conversionRate: 0.1, avgTalkSec: 150, callbacksDue: 5, callbacksOnTime: 4, callbackCompliance: 0.8 });
    expect(s!.dialledPerHour).toBe(10); // 100 calls over 4 h + 6 h
    expect(clockOf(s!.avgFirstCallMin)).toBe("10:00");
    expect(clockOf(s!.avgLastCallMin)).toBe("15:00");
  });

  it("formats durations", () => {
    expect(duration(3725)).toBe("1h 02m");
    expect(duration(250)).toBe("4m 10s");
    expect(duration(null)).toBe("—");
  });
});
