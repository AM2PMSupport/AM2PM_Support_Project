import { describe, expect, it } from "vitest";
import { can, canSeeFullPhone, homeFor, leadScope, navFor } from "@/lib/auth/rbac";

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
