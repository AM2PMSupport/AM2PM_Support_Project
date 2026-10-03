/**
 * WORKPHASE.md (owner's phase view) must agree with TASK.md (task specs):
 * same tasks, same status, and Overview numbers that add up. Fails when one
 * file is updated without the other — update both in the same change.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const task = readFileSync("TASK.md", "utf8");
const work = readFileSync("WORKPHASE.md", "utf8");
const ICON: Record<string, string> = { x: "✅", "~": "🟡", " ": "⬜", "-": "❌" };

const tasks = [...task.matchAll(/^- \[([ ~x-])\] (T[\d.]+[a-z]?) /gm)].map((m) => ({ id: m[2]!, icon: ICON[m[1]!]! }));
const rows = new Map([...work.matchAll(/^\| (T[\d.]+[a-z]?) \| (✅|🟡|⬜|❌)/gm)].map((m) => [m[1]!, m[2]!]));

describe("WORKPHASE.md ↔ TASK.md", () => {
  it("every task appears with the same status", () => {
    const wrong = tasks.filter((t) => rows.get(t.id) !== t.icon).map((t) => `${t.id}: TASK.md ${t.icon}, WORKPHASE.md ${rows.get(t.id) ?? "missing"}`);
    expect(wrong).toEqual([]);
  });

  it("no task in WORKPHASE.md that TASK.md doesn't have", () => {
    const ids = new Set(tasks.map((t) => t.id));
    expect([...rows.keys()].filter((id) => !ids.has(id))).toEqual([]);
  });

  it("Overview numbers match each phase's task table", () => {
    for (const phase of [0, 1, 2, 3, 4]) {
      const start = work.indexOf(`\n## Phase ${phase} `);
      const end = work.indexOf("\n## ", start + 5);
      const section = work.slice(start, end);
      const icons = [...section.matchAll(/^\| T[\d.]+[a-z]? \| (✅|🟡|⬜|❌)/gm)].map((m) => m[1]);
      const count = (i: string) => icons.filter((x) => x === i).length;
      const overview = new RegExp(`^\\| \\[Phase ${phase}\\][^|]*\\|[^|]*\\| (\\d+) \\| (\\d+) \\| (\\d+) \\|`, "m").exec(work);
      expect(overview, `Overview row for Phase ${phase}`).not.toBeNull();
      expect([Number(overview![1]), Number(overview![2]), Number(overview![3])], `Phase ${phase} overview`).toEqual([count("✅"), count("🟡"), count("⬜")]);
    }
  });
});
