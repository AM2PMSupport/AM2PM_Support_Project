import { describe, expect, it } from "vitest";
import { validateCustom } from "@/lib/admin/custom-fields";
import type { CustomFieldDefinition } from "@/lib/db/schema";

const d = (key: string, type: string, extra: Partial<CustomFieldDefinition> = {}) =>
  ({ id: key, tenantId: "t", entity: "lead", processId: null, key, label: key, type, options: [], required: false, isActive: true, sortOrder: 0, createdAt: new Date(), updatedAt: new Date(), ...extra }) as CustomFieldDefinition;

describe("validateCustom — new field types (Lead layout palette)", () => {
  it("coerces numbers, currency, percent; checks radio, url, datetime, user", () => {
    const defs = [
      d("amt", "currency"),
      d("pct", "percent"),
      d("dec", "decimal"),
      d("pick", "radio", { options: ["A", "B"] }),
      d("site", "url"),
      d("when", "datetime"),
      d("by", "user"),
      d("notes", "textarea"),
    ];
    const ok = validateCustom(defs, { amt: "₹1,25,000", pct: "12.5%", dec: "3.14", pick: "B", site: "example.com/x", when: "2026-10-06T08:30:00.000Z", by: "00000000-0000-4000-8000-000000000001", notes: "line 1\nline 2" });
    expect(ok.errors).toEqual([]);
    expect(ok.value).toMatchObject({ amt: 125000, pct: 12.5, dec: 3.14, pick: "B", site: "https://example.com/x", when: "2026-10-06T08:30:00.000Z", notes: "line 1\nline 2" });

    const bad = validateCustom(defs, { amt: "lots", pick: "C", site: "not a url with spaces", when: "someday", by: "asha" });
    expect(bad.errors).toEqual([
      "amt must be a number",
      "pick must be one of: A, B",
      "site must be a web address",
      "when must be a date and time",
      "by must be a person",
    ]);
  });

  it("required fields must be filled", () => {
    expect(validateCustom([d("budget", "currency", { required: true })], {}).errors).toEqual(["budget is required"]);
  });
});
