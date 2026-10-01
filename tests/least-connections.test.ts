import { describe, expect, it } from "vitest";
import { pickLeastConnections, type TargetLoad } from "@/lib/db/least-connections";
import { isConnectionError } from "@/lib/db/client";

const t = (active: number, over: Partial<TargetLoad> = {}): TargetLoad => ({ active, waiting: 0, healthy: true, lastPicked: 0, ...over });

describe("least-connections pick", () => {
  it("picks the target with the fewest active connections", () => {
    expect(pickLeastConnections([t(5), t(2), t(7)])).toBe(1);
  });

  it("counts waiting requests as load", () => {
    expect(pickLeastConnections([t(2, { waiting: 4 }), t(3)])).toBe(1);
  });

  it("skips unhealthy targets (circuit open)", () => {
    expect(pickLeastConnections([t(0, { healthy: false }), t(9)])).toBe(1);
  });

  it("returns -1 when nothing is healthy, so the caller uses the primary", () => {
    expect(pickLeastConnections([t(0, { healthy: false })])).toBe(-1);
    expect(pickLeastConnections([])).toBe(-1);
  });

  it("breaks ties by least recently picked, spreading equal load", () => {
    expect(pickLeastConnections([t(1, { lastPicked: 7 }), t(1, { lastPicked: 3 }), t(1, { lastPicked: 5 })])).toBe(1);
  });
});

describe("connection error detection (what we fail over on)", () => {
  it("treats network and server-shutdown errors as connection errors", () => {
    expect(isConnectionError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isConnectionError({ code: "57P01" })).toBe(true); // admin shutdown (compute restart)
    expect(isConnectionError({ message: "Connection terminated unexpectedly" })).toBe(true);
    expect(isConnectionError({ cause: { code: "ETIMEDOUT" } })).toBe(true);
  });

  it("does not fail over on ordinary SQL errors", () => {
    expect(isConnectionError({ code: "23505" })).toBe(false); // unique violation
    expect(isConnectionError({ code: "42P01" })).toBe(false); // undefined table
  });
});
