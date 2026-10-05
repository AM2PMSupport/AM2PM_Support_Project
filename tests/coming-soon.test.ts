import { describe, expect, it } from "vitest";
import { SOON_MODULES, soonModule } from "@/lib/ui/coming-soon";

describe("coming-soon showcase catalogue", () => {
  it("has unique URL-safe slugs and a full preview for every module", () => {
    const slugs = SOON_MODULES.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const m of SOON_MODULES) {
      expect(m.slug).toMatch(/^[a-z][a-z-]*$/);
      expect(m.features.length).toBeGreaterThan(2);
      expect(m.preview.kpis.length).toBeGreaterThan(0);
      for (const row of m.preview.table.rows) expect(row).toHaveLength(m.preview.table.columns.length);
    }
  });
  it("looks modules up by slug", () => {
    expect(soonModule("reports")?.title).toBe("Reports & analytics");
    expect(soonModule("nope")).toBeUndefined();
  });
});
