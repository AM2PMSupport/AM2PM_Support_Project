import { describe, expect, it } from "vitest";
import { newDataKey, openChunk, pruneList, sealChunk } from "@/lib/backups/format";

describe("backup files", () => {
  it("round-trips rows, compresses, and refuses the wrong key or a tampered file", () => {
    const key = newDataKey();
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `id-${i}`, name: "Asha Rao", note: "same text ".repeat(20), n: i }));
    const buf = sealChunk(rows, key);
    expect(openChunk(buf, key)).toEqual(rows);
    expect(buf.length).toBeLessThan(JSON.stringify(rows).length / 5); // gzip
    expect(buf.toString("utf8")).not.toContain("Asha"); // encrypted
    expect(() => openChunk(buf, newDataKey())).toThrow();
    const bad = Buffer.from(buf);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    expect(() => openChunk(bad, key)).toThrow();
    expect(openChunk(sealChunk([], key), key)).toEqual([]);
  });
});

describe("retention", () => {
  const days = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 9, 6) - i * 86_400_000).toISOString().slice(0, 10));
  const snaps = days.map((d) => ({ id: d, day: d }));

  it("keeps 7 daily + 4 weekly + 3 monthly, deletes the rest", () => {
    const del = new Set(pruneList(snaps, { keepDaily: 7, keepWeekly: 4, keepMonthly: 3 }));
    const kept = days.filter((d) => !del.has(d));
    expect(kept.slice(0, 7)).toEqual(days.slice(0, 7)); // newest 7 days
    expect(kept).toEqual(expect.arrayContaining(["2026-09-30", "2026-08-31"])); // newest of each of the last 3 months (Oct, Sep, Aug)
    expect(kept).not.toContain("2026-07-31");
    expect(kept.length).toBeLessThanOrEqual(7 + 4 + 3);
    expect(del.has("2026-06-15")).toBe(true);
  });

  it("never deletes the only snapshot", () => {
    expect(pruneList([{ id: "a", day: "2026-10-06" }], { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 })).toEqual([]);
  });
});
