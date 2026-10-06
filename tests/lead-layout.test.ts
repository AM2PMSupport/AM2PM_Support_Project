import { describe, expect, it } from "vitest";
import { defaultLayout, layoutColumns, normalizeLayout, resolveLayout, SYSTEM_FIELDS, type FieldDef } from "@/lib/leads/layout";

const all = (l: ReturnType<typeof normalizeLayout>) => [...l.sections.flatMap((s) => s.fields), ...l.hidden];
const def = (key: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key.toUpperCase(), type: "text", options: [], required: false, ...extra });

describe("normalizeLayout", () => {
  it("empty or junk → the default layout with every field once", () => {
    for (const raw of [null, {}, { sections: [] }, "x", 42]) {
      const l = normalizeLayout(raw, ["budget"]);
      expect(l).toEqual(defaultLayout(["budget"]));
      expect(new Set(all(l)).size).toBe(all(l).length);
      expect(all(l)).toHaveLength(SYSTEM_FIELDS.length + 1);
    }
  });

  it("drops unknown and duplicate refs, appends new fields, keeps order", () => {
    const l = normalizeLayout(
      { sections: [{ id: "a", title: "Top", fields: ["sys:email", "cf:gone", "sys:name", "sys:email"] }, { id: "b", title: "More", fields: ["cf:budget"] }], hidden: ["sys:dnc", "sys:nope"] },
      ["budget", "course"],
    );
    expect(l.sections[0]!.fields.slice(0, 2)).toEqual(["sys:email", "sys:name"]);
    expect(l.sections[1]!.fields).toEqual(["cf:budget", "cf:course"]); // new custom field → last section
    expect(l.hidden).toEqual(["sys:dnc"]);
    expect(new Set(all(l)).size).toBe(all(l).length);
    expect(all(l)).toHaveLength(SYSTEM_FIELDS.length + 2);
  });

  it("Name and Mobile can't be hidden; labels only for system fields", () => {
    const l = normalizeLayout({ sections: [{ id: "a", title: "A", fields: [] }], hidden: ["sys:name", "sys:phone", "sys:email"], labels: { "sys:phone": "Customer phone", "cf:x": "no", "sys:email": "" } }, []);
    expect(l.hidden).toEqual(["sys:email"]);
    expect(l.sections[0]!.fields.slice(0, 2)).toEqual(["sys:name", "sys:phone"]);
    expect(l.labels).toEqual({ "sys:phone": "Customer phone" });
  });

  it("section ids are safe and unique; titles capped", () => {
    const l = normalizeLayout({ sections: [{ id: "x y<script>", title: "T".repeat(99), fields: [] }, { id: "xyscript", title: "", fields: [] }] }, []);
    expect(l.sections.map((s) => s.id)).toEqual(["xyscript", "xyscript-2"]);
    expect(l.sections[0]!.title).toHaveLength(60);
    expect(l.sections[1]!.title).toBe("Section");
  });
});

describe("resolveLayout / layoutColumns", () => {
  const layout = normalizeLayout(
    { sections: [{ id: "a", title: "Main", fields: ["sys:phone", "cf:budget", "sys:name", "cf:other_process"] }, { id: "b", title: "Empty", fields: [] }], hidden: ["sys:email"], labels: { "sys:phone": "Customer phone" } },
    ["budget", "other_process"],
  );

  it("one lead: hidden, other-process fields and empty sections left out; labels applied", () => {
    const r = resolveLayout(layout, [def("budget", { required: true })]);
    expect(r[0]!.fields.slice(0, 3).map((f) => [f.ref, f.label])).toEqual([["sys:phone", "Customer phone"], ["cf:budget", "BUDGET"], ["sys:name", "Name"]]);
    expect(r.flatMap((s) => s.fields).some((f) => f.ref === "cf:other_process" || f.ref === "sys:email")).toBe(false);
    expect(r.some((s) => s.title === "Empty")).toBe(false);
  });

  it("columns: visible system columns + custom fields, in layout order, with labels", () => {
    const cols = layoutColumns(layout, [def("budget"), def("other_process")]);
    expect(cols.slice(0, 3)).toEqual([{ key: "phone", label: "Customer phone" }, { key: "cf:budget", label: "BUDGET" }, { key: "cf:other_process", label: "OTHER_PROCESS" }]);
    expect(cols.some((c) => c.key === "email")).toBe(false);
  });
});
