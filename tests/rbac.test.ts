import { describe, expect, it } from "vitest";
import { can, canSeeFullPhone, defaultGrants, effectiveGrants, homeFor, landingAfterSwitch, leadScope, navFor, normalizeActions, permissionMatrix, screenMatrix } from "@/lib/auth/rbac";

describe("permission matrix (DESIGN.md §7)", () => {
  it("matches key cells", () => {
    expect(can({ role: "super_admin" }, "config", "D")).toBe(true);
    expect(can({ role: "admin" }, "config", "D")).toBe(false);
    expect(can({ role: "admin" }, "integrations", "C")).toBe(true);
    expect(can({ role: "manager" }, "integrations", "V")).toBe(false);
    expect(can({ role: "agent" }, "leads", "E")).toBe(true);
    expect(can({ role: "agent" }, "leads", "X")).toBe(false); // agents cannot export
    expect(can({ role: "client" }, "leads", "E")).toBe(false);
    expect(can({ role: "process_coordinator" }, "users", "E")).toBe(false);
  });

  it("scopes leads by role", () => {
    expect(leadScope("agent")).toBe("own");
    expect(leadScope("manager")).toBe("process");
    expect(leadScope("admin")).toBe("tenant");
    expect(leadScope("client")).toBe("process"); // only matters once Setup grants it lead rights
  });

  it("masks phones for agents, coordinators, clients and trainers", () => {
    expect(canSeeFullPhone("manager")).toBe(true);
    expect(canSeeFullPhone("agent")).toBe(false);
    expect(canSeeFullPhone("client")).toBe(false);
  });

  it("builds the nav and home page per role", () => {
    expect(navFor({ role: "agent" })).toEqual(["console", "leads", "calls", "reports", "attendance", "soon"]); // reports / attendance: own only
    expect(navFor({ role: "manager" })).toEqual(["console", "leads", "calls", "dashboard", "reports", "attendance", "admin", "soon"]);
    expect(navFor({ role: "super_admin" })).toEqual(["console", "leads", "calls", "dashboard", "reports", "attendance", "admin", "soon"]);
    expect(navFor({ role: "accounts" })).not.toContain("attendance");
    expect(navFor({ role: "client" })).not.toContain("reports"); // off until the client portal (T3.5)
    expect(navFor({ role: "trainer" })).toEqual(["dashboard", "reports", "soon"]);
    expect(homeFor({ role: "trainer" })).toBe("/dashboard");
    expect(homeFor({ role: "client" })).toBe("/dashboard");
    expect(homeFor({ role: "agent" })).toBe("/console");
  });
});

describe("landingAfterSwitch", () => {
  it("stays on the module the person was on", () => {
    expect(landingAfterSwitch({ role: "admin" }, "/leads")).toBe("/leads");
    expect(landingAfterSwitch({ role: "admin" }, "/calls")).toBe("/calls");
    expect(landingAfterSwitch({ role: "admin" }, "/dashboard")).toBe("/dashboard");
    expect(landingAfterSwitch({ role: "agent" }, "/leads")).toBe("/leads");
    expect(landingAfterSwitch({ role: "client" }, "/soon/reports")).toBe("/soon");
  });

  it("drops filters and the open lead (old workspace ids), keeps the Setup tab", () => {
    expect(landingAfterSwitch({ role: "admin" }, "/leads?process=abc&status=all")).toBe("/leads");
    expect(landingAfterSwitch({ role: "admin" }, "/console?lead=1b2c")).toBe("/console");
    expect(landingAfterSwitch({ role: "admin" }, "/admin?tab=team")).toBe("/admin?tab=team");
    expect(landingAfterSwitch({ role: "admin" }, "/admin?tab=x%22y")).toBe("/admin");
  });

  it("falls back to home when the new role can't open the module", () => {
    expect(landingAfterSwitch({ role: "agent" }, "/admin?tab=team")).toBe(homeFor({ role: "agent" }));
    expect(landingAfterSwitch({ role: "agent" }, "/dashboard")).toBe(homeFor({ role: "agent" }));
    expect(landingAfterSwitch({ role: "client" }, "/console")).toBe(homeFor({ role: "client" }));
  });

  it("ignores anything that isn't a module path", () => {
    for (const bad of [undefined, "", "/", "//evil.com", "https://evil.com/leads", "/leads/../admin", "/no-access", "/leadsX"]) {
      expect(landingAfterSwitch({ role: "admin" }, bad)).toBe(homeFor({ role: "admin" }));
    }
  });
});

describe("new roles: HR, Auditor, Accounts (2026-10-05)", () => {
  it("HR manages employee profiles and opens Setup, no leads", () => {
    expect(can({ role: "hr" }, "employees", "E")).toBe(true);
    expect(can({ role: "hr" }, "leads", "V")).toBe(false);
    expect(leadScope("hr")).toBe("process");
    expect(navFor({ role: "hr" })).toEqual(["attendance", "admin", "soon"]);
    expect(homeFor({ role: "hr" })).toBe("/admin");
  });

  it("Auditor reads every lead and call in the workspace but changes nothing", () => {
    expect(leadScope("auditor")).toBe("tenant");
    expect(can({ role: "auditor" }, "leads", "V")).toBe(true);
    expect(can({ role: "auditor" }, "interactions", "X")).toBe(true);
    for (const a of ["C", "E", "D", "I"] as const) expect(can({ role: "auditor" }, "leads", a)).toBe(false);
    expect(can({ role: "auditor" }, "interactions", "C")).toBe(false); // can't place calls
    expect(canSeeFullPhone("auditor")).toBe(false);
  });

  it("Accounts owns billing and sees reports", () => {
    expect(can({ role: "accounts" }, "billing", "A")).toBe(true);
    expect(can({ role: "accounts" }, "leads", "V")).toBe(false);
    expect(homeFor({ role: "accounts" })).toBe("/dashboard");
  });

  it("I (import) gates CSV import: admins yes, supervisors no", () => {
    expect(can({ role: "admin" }, "leads", "I")).toBe(true);
    expect(can({ role: "project_supervisor" }, "leads", "I")).toBe(false);
  });
});

describe("workspace permission edits (Setup → Roles)", () => {
  it("an edit replaces the default cell; empty = no access", () => {
    const g = effectiveGrants("manager", [
      { role: "manager", module: "leads", actions: "VI" },
      { role: "manager", module: "config", actions: "" },
    ]);
    expect(g.leads).toBe("VI");
    expect(g.config).toBeUndefined();
    expect(can({ role: "manager", grants: g }, "leads", "I")).toBe(true);
    expect(can({ role: "manager", grants: g }, "leads", "E")).toBe(false);
    expect(navFor({ role: "manager", grants: g })).toContain("admin"); // still sees Users (VE)
  });

  it("checks use the grants given, not the defaults", () => {
    const g = effectiveGrants("agent", [{ role: "agent", module: "leads", actions: "" }]);
    expect(can({ role: "agent" }, "leads", "V")).toBe(true);
    expect(can({ role: "agent", grants: g }, "leads", "V")).toBe(false);
    expect(navFor({ role: "agent", grants: g })).not.toContain("leads");
  });

  it("ignores edits for Super Admin, other roles, unknown areas and bad letters", () => {
    const edits = [
      { role: "super_admin", module: "config", actions: "" },
      { role: "admin", module: "leads", actions: "" },
      { role: "manager", module: "nope", actions: "VCEDAXI" },
      { role: "manager", module: "leads", actions: "XEVzz" },
    ];
    expect(effectiveGrants("super_admin", edits)).toEqual(defaultGrants("super_admin"));
    expect(effectiveGrants("manager", edits).leads).toBe("VEX");
    expect(Object.keys(effectiveGrants("manager", edits))).not.toContain("nope");
  });

  it("normalises letters to VCEDAXI order", () => {
    expect(normalizeActions("IXV")).toBe("VXI");
    expect(normalizeActions("vce")).toBe("");
  });

  it("marks edited cells in the matrix", () => {
    const m = permissionMatrix([{ role: "trainer", module: "reports", actions: "VX" }]);
    const reports = m.find((r) => r.module === "reports")!;
    expect(reports.grants.trainer).toBe("VX");
    expect(reports.edited.trainer).toBe(true);
    expect(reports.edited.admin).toBeUndefined();
  });
});

describe("module access (Setup → Roles)", () => {
  const off = (role: string, screen: string) => ({ role, module: `screen.${screen}`, actions: "" });

  it("hides a switched-off module and moves home to the next one", () => {
    const grants = effectiveGrants("agent", [off("agent", "console"), off("agent", "soon")]);
    expect(navFor({ role: "agent", grants })).toEqual(["leads", "calls", "reports", "attendance"]);
    expect(homeFor({ role: "agent", grants })).toBe("/no-access");
    expect(landingAfterSwitch({ role: "agent", grants }, "/console")).toBe("/no-access");
  });

  it("can't open a module the permissions don't support, and Super Admin is fixed", () => {
    const grants = effectiveGrants("hr", []);
    expect(navFor({ role: "hr", grants })).not.toContain("leads");
    expect(effectiveGrants("super_admin", [off("super_admin", "admin")])["screen.admin"]).toBe("V");
  });

  it("reports on / available / edited per role", () => {
    const row = screenMatrix([off("manager", "calls")]).find((r) => r.screen === "calls")!;
    expect(row.on.manager).toBe(false);
    expect(row.edited.manager).toBe(true);
    expect(row.available.manager).toBe(true);
    expect(row.available.hr).toBe(false);
    expect(row.on.agent).toBe(true);
    const floor = screenMatrix().find((r) => r.screen === "dashboard")!;
    expect([floor.on.agent, floor.available.agent, floor.edited.agent]).toEqual([false, true, undefined]); // off by default, not an edit
  });
});
