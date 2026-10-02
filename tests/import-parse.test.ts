/** Spreadsheet parsing + header guessing for imports (T1.26). */
import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/imports/parse";
import { normaliseLead } from "@/lib/leads/normalise";

describe("parseCsv", () => {
  it("uses the first row as headers, strips a BOM, skips blank lines, keeps quoted commas", () => {
    const s = parseCsv('﻿Full Name,Mobile No.,Email ID,City\n"Rao, Asha",98765 43210,ASHA@X.IN,Pune\n\n,,,\nRavi,9123456780,,\n');
    expect(s.headers).toEqual(["Full Name", "Mobile No.", "Email ID", "City"]);
    expect(s.rows).toHaveLength(2);
    expect(s.rows[0]).toMatchObject({ "Full Name": "Rao, Asha", City: "Pune" });
  });

  it("names blank and repeated headers instead of dropping data", () => {
    expect(parseCsv("phone,,phone\n9876543210,a,b\n").headers).toEqual(["phone", "column_2", "phone_2"]);
  });
});

describe("header guessing via normaliseLead", () => {
  it.each([
    ["Full Name", "Mobile No.", "Email ID"],
    ["Customer Name", "Phone Number", "E-mail"],
    ["lead-name", "contact number", "email"],
  ])("%s / %s / %s", (n, p, e) => {
    const r = normaliseLead({ [n]: "Asha", [p]: "+91 98765 43210", [e]: "A@X.IN", Budget: "5L" });
    expect(r).toMatchObject({ ok: true, lead: { name: "Asha", phoneKey: "9876543210", email: "a@x.in", custom: { Budget: "5L" } } });
  });
});
