import { describe, expect, it } from "vitest";
import { can, canSeeFullPhone, homeFor, landingAfterSwitch, leadScope, navFor } from "@/lib/auth/rbac";

describe("permission matrix (DESIGN.md §7)", () => {
  it("matches key cells", () => {
    expect(can("super_admin", "config", "D")).toBe(true);
    expect(can("admin", "config", "D")).toBe(false);
    expect(can("admin", "integrations", "C")).toBe(true);
    expect(can("manager", "integrations", "V")).toBe(false);
    expect(can("agent", "leads", "E")).toBe(true);
    expect(can("agent", "leads", "X")).toBe(false); // agents cannot export
    expect(can("client", "leads", "E")).toBe(false);
    expect(can("process_coordinator", "users", "E")).toBe(false);
  });

  it("scopes leads by role", () => {
    expect(leadScope("agent")).toBe("own");
    expect(leadScope("manager")).toBe("process");
    expect(leadScope("admin")).toBe("tenant");
    expect(leadScope("client")).toBe("none");
  });

  it("masks phones for agents, coordinators, clients and trainers", () => {
    expect(canSeeFullPhone("manager")).toBe(true);
    expect(canSeeFullPhone("agent")).toBe(false);
    expect(canSeeFullPhone("client")).toBe(false);
  });

  it("builds the nav and home page per role", () => {
    expect(navFor("agent")).toEqual(["console", "leads", "calls"]);
    expect(navFor("manager")).toEqual(["console", "leads", "calls", "dashboard", "admin"]);
    expect(navFor("super_admin")).toEqual(["console", "leads", "calls", "dashboard", "admin"]);
    expect(navFor("trainer")).toEqual(["dashboard"]);
    expect(homeFor("trainer")).toBe("/dashboard");
    expect(homeFor("client")).toBe("/dashboard");
    expect(homeFor("agent")).toBe("/console");
  });
});

describe("landingAfterSwitch", () => {
  it("stays on the module the person was on", () => {
    expect(landingAfterSwitch("admin", "/leads")).toBe("/leads");
    expect(landingAfterSwitch("admin", "/calls")).toBe("/calls");
    expect(landingAfterSwitch("admin", "/dashboard")).toBe("/dashboard");
    expect(landingAfterSwitch("agent", "/leads")).toBe("/leads");
  });

  it("drops filters and the open lead (old workspace ids), keeps the Setup tab", () => {
    expect(landingAfterSwitch("admin", "/leads?process=abc&status=all")).toBe("/leads");
    expect(landingAfterSwitch("admin", "/console?lead=1b2c")).toBe("/console");
    expect(landingAfterSwitch("admin", "/admin?tab=team")).toBe("/admin?tab=team");
    expect(landingAfterSwitch("admin", "/admin?tab=x%22y")).toBe("/admin");
  });

  it("falls back to home when the new role can't open the module", () => {
    expect(landingAfterSwitch("agent", "/admin?tab=team")).toBe(homeFor("agent"));
    expect(landingAfterSwitch("agent", "/dashboard")).toBe(homeFor("agent"));
    expect(landingAfterSwitch("client", "/console")).toBe(homeFor("client"));
  });

  it("ignores anything that isn't a module path", () => {
    for (const bad of [undefined, "", "/", "//evil.com", "https://evil.com/leads", "/leads/../admin", "/no-access", "/leadsX"]) {
      expect(landingAfterSwitch("admin", bad)).toBe(homeFor("admin"));
    }
  });
});
