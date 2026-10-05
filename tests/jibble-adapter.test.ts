import { describe, expect, it } from "vitest";
import { parseEntry, parseHoliday, parseLeave, parsePerson } from "@/lib/providers/workforce/jibble";

describe("Jibble adapter parsing (tolerant field names)", () => {
  it("people: email lower-cased, name from parts when needed", () => {
    expect(parsePerson({ id: "p1", email: "Asha@X.com", fullName: "Asha R", code: "E1", status: "Active" })).toEqual({ id: "p1", email: "asha@x.com", fullName: "Asha R", code: "E1", status: "Active" });
    expect(parsePerson({ id: "p2", firstName: "Ravi", lastName: "K" })?.fullName).toBe("Ravi K");
    expect(parsePerson({ id: "p3" })?.fullName).toBe("—");
    expect(parsePerson({ email: "x@y" })).toBeNull();
  });

  it("time entries: the documented TimeEntries shape; junk is dropped", () => {
    const e = parseEntry({ id: "e1", personId: "p1", type: "In", time: "2026-10-06T03:30:00Z", belongsToDate: "2026-10-06" });
    expect(e).toEqual({ id: "e1", personId: "p1", type: "In", at: new Date("2026-10-06T03:30:00Z"), belongsToDate: "2026-10-06" });
    expect(parseEntry({ id: "e2", personId: "p1", type: "Out", time: "not a date" })).toBeNull();
    expect(parseEntry({ id: "e3", type: "In", time: "2026-10-06T03:30:00Z" })).toBeNull();
  });

  it("leave and holidays: several spellings, one-day leave", () => {
    expect(parseLeave({ id: "l1", personId: "p1", startDate: "2026-10-06T00:00:00", endDate: "2026-10-07", status: "Approved", policyName: "Casual" })).toEqual({ id: "l1", personId: "p1", startDate: "2026-10-06", endDate: "2026-10-07", status: "Approved", kind: "Casual" });
    expect(parseLeave({ timeOffId: "l2", personId: "p1", date: "2026-10-09" })).toMatchObject({ startDate: "2026-10-09", endDate: "2026-10-09" });
    expect(parseHoliday({ startDate: "2026-12-25T00:00:00", title: "Christmas" })).toEqual({ date: "2026-12-25", name: "Christmas" });
    expect(parseHoliday({ name: "No date" })).toBeNull();
  });
});
