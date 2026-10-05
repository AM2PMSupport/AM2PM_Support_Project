import { describe, expect, it } from "vitest";
import { capPerTenant, rotate } from "@/lib/jobs/fair";
import { isSettled } from "@/lib/telephony/sync";

describe("rotate (round-robin across ticks)", () => {
  it("starts after the client the last run reached, wrapping around", () => {
    expect(rotate(["a", "b", "c", "d"], "b")).toEqual(["c", "d", "a", "b"]);
    expect(rotate(["a", "b", "c"], "c")).toEqual(["a", "b", "c"]);
  });
  it("keeps the order when there is no cursor or it's gone", () => {
    expect(rotate(["a", "b"], null)).toEqual(["a", "b"]);
    expect(rotate(["a", "b"], "zz")).toEqual(["a", "b"]);
  });
});

describe("capPerTenant (no client starves the batch)", () => {
  it("keeps at most N per client in the original order", () => {
    const rows = [..."AAAAB"].map((t, i) => ({ tenantId: t, i }));
    expect(capPerTenant(rows, 2).map((r) => `${r.tenantId}${r.i}`)).toEqual(["A0", "A1", "B4"]);
  });
});

describe("isSettled (call sync skips finished rows)", () => {
  const settled = new Map([
    ["done", { status: "completed", copied: true }],
    ["uncopied", { status: "completed", copied: false }],
    ["ringing", { status: "ringing", copied: false }],
  ]);
  it("skips a terminal call whose recording is copied (or has none)", () => {
    expect(isSettled([{ providerCallId: "done", recordingUrl: "https://x" }], settled)).toBe(true);
    expect(isSettled([{ providerCallId: "uncopied" }], settled)).toBe(true);
  });
  it("re-processes unknown, unfinished or uncopied calls", () => {
    expect(isSettled([{ providerCallId: "uncopied", recordingUrl: "https://x" }], settled)).toBe(false);
    expect(isSettled([{ providerCallId: "ringing" }], settled)).toBe(false);
    expect(isSettled([{ providerCallId: "new" }], settled)).toBe(false);
    expect(isSettled([{}], settled)).toBe(false);
    expect(isSettled([], settled)).toBe(false);
  });
});
