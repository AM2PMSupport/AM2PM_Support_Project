/**
 * Role-based access control (DESIGN.md §7) — pure, unit-tested.
 *
 * Actions: V view · C create · E edit · D delete · A approve · X export ·
 * I import. DEFAULTS is the starting matrix for every workspace; a Super
 * Admin can change any cell for their workspace (Setup → Roles, stored in
 * role_permissions, lib/admin/roles.ts). Super Admin's own grants are fixed
 * so nobody can lock the workspace out.
 *
 * Checks take a `Who` — the actor with its workspace's effective grants
 * (loaded once per request by lib/auth/session.ts / lib/api/context.ts via
 * lib/auth/grants.ts). A Who without `grants` (tests, system code) uses the
 * defaults. A bare Role is deliberately NOT accepted, so a check can't
 * silently skip the workspace's edits.
 *
 * Module access (2026-10-05): each sidebar module (SCREENS) is also a
 * switch per role, stored in the same table as `screen.<name>` with "V" = on
 * and "" = off (defaults: SCREEN_OFF). A module shows when it is on AND the
 * role's permissions can use it (navAvailable). Switching a module on in
 * Setup also grants View on the area it needs (SCREEN_NEEDS,
 * lib/admin/roles.ts), so any role can be given any module per workspace.
 *
 * Data scope is separate from permission: an agent may "VE" leads, but only
 * their OWN (leadScope). Tenant isolation itself is enforced by Postgres RLS;
 * these rules narrow access further inside a tenant.
 */
import { forbidden } from "@/lib/http/errors";
import type { Role } from "@/lib/db/schema";

export const MODULES = [
  "config", // processes, dispositions, custom fields, workspace settings
  "users",
  "leads",
  "interactions",
  "callbacks",
  "import_sources",
  "webhooks",
  "reports",
  "integrations",
  "backups",
  "audit",
  "employees", // HR: employee profiles (screens: TODO(T1.49))
  "billing", // Accounts: invoices and billing (screens: TODO(T1.50))
] as const;
export type Module = (typeof MODULES)[number];

export const ACTIONS = ["V", "C", "E", "D", "A", "X", "I"] as const;
export type Action = (typeof ACTIONS)[number];

/** Every role, in the order Setup shows them. */
export const ROLES: Role[] = ["super_admin", "admin", "project_supervisor", "manager", "process_coordinator", "trainer", "client", "agent", "hr", "auditor", "accounts"];

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  project_supervisor: "Supervisor",
  manager: "Manager",
  process_coordinator: "Coordinator",
  trainer: "Trainer",
  client: "Client",
  agent: "Agent",
  hr: "HR",
  auditor: "Auditor",
  accounts: "Accounts",
};

/** Sidebar modules, in rail order. */
export const SCREENS = ["console", "leads", "calls", "dashboard", "admin", "soon"] as const;
export type Screen = (typeof SCREENS)[number];
export type ScreenKey = `screen.${Screen}`;
export const SCREEN_KEYS = SCREENS.map((s) => `screen.${s}` as ScreenKey);

/** The permission area each module needs at least View on (Setup: any SETUP_MODULES; config is the one granted). */
export const SCREEN_NEEDS: Record<Screen, Module | null> = { console: "leads", leads: "leads", calls: "interactions", dashboard: "reports", admin: "config", soon: null };

/** Modules switched off by default (role can use them, but doesn't see them until a Super Admin turns them on). */
const SCREEN_OFF: Partial<Record<Role, Screen[]>> = { agent: ["dashboard"], client: ["console", "leads", "calls"] };

/** One role's grants: module → actions string (e.g. "VCE"), plus module-access switches. */
export type Grants = Partial<Record<Module | ScreenKey, string>>;

/** The actor a check is about. `grants` = this workspace's effective grants for the role. */
export interface Who {
  role: Role;
  grants?: Grants;
}

type Matrix = Record<Module, Partial<Record<Role, string>>>;

const DEFAULTS: Matrix = {
  config: { super_admin: "VCEDAX", admin: "VCE", project_supervisor: "V", manager: "V" },
  users: { super_admin: "VCEDAXI", admin: "VCEDXI", project_supervisor: "VE", manager: "VE", process_coordinator: "V", hr: "V" },
  leads: { super_admin: "VCEDAXI", admin: "VCEDXI", project_supervisor: "VCEAX", manager: "VCEAX", process_coordinator: "VCE", client: "V", agent: "VE", auditor: "VX" },
  interactions: { super_admin: "VX", admin: "VX", project_supervisor: "VX", manager: "VX", process_coordinator: "V", client: "V", agent: "VC", auditor: "VX" },
  callbacks: { super_admin: "VCEDX", admin: "VCEDX", project_supervisor: "VCEA", manager: "VCEA", process_coordinator: "VCE", agent: "VCE", auditor: "V" },
  import_sources: { super_admin: "VCED", admin: "VCED", project_supervisor: "V", manager: "V" },
  webhooks: { super_admin: "VCEDX", admin: "VCED", project_supervisor: "VE", manager: "V" },
  reports: { super_admin: "VX", admin: "VX", project_supervisor: "VX", manager: "VX", process_coordinator: "V", trainer: "V", client: "V", agent: "V", auditor: "VX", accounts: "VX" },
  integrations: { super_admin: "VCED", admin: "VCE" },
  backups: { super_admin: "VCEDAX", admin: "VCX", project_supervisor: "V", manager: "V", client: "V" },
  audit: { super_admin: "V", admin: "V", auditor: "V" },
  employees: { super_admin: "VCEDAXI", admin: "VCEDXI", hr: "VCEDAXI", project_supervisor: "V", manager: "V" },
  billing: { super_admin: "VCEDAXI", admin: "V", accounts: "VCEDAXI" },
};

/** Roles whose grants can't be edited (lock-out protection). */
export const LOCKED_ROLES: readonly Role[] = ["super_admin"];

/** A role's default grants (before any workspace edits). */
export function defaultGrants(role: Role): Grants {
  const g: Grants = {};
  for (const m of MODULES) if (DEFAULTS[m][role]) g[m] = DEFAULTS[m][role];
  for (const s of SCREENS) if (!SCREEN_OFF[role]?.includes(s)) g[`screen.${s}`] = "V";
  return g;
}

/** Keeps only known letters (upper-case), once each, in VCEDAXI order: "XEV" → "VEX". */
export function normalizeActions(actions: string): string {
  return ACTIONS.filter((a) => actions.includes(a)).join("");
}

/** Every key a role_permissions row may hold. */
export const GRANT_KEYS: readonly (Module | ScreenKey)[] = [...MODULES, ...SCREEN_KEYS];

/**
 * Defaults + this workspace's stored edits → the grants checks use. Edits for
 * locked roles or unknown modules are ignored (a bad row can't widen access
 * beyond what Setup could have saved).
 */
export function effectiveGrants(role: Role, edits: { role: string; module: string; actions: string }[]): Grants {
  const g = defaultGrants(role);
  if (LOCKED_ROLES.includes(role)) return g;
  for (const e of edits) {
    const key = e.module as Module | ScreenKey;
    if (e.role !== role || !GRANT_KEYS.includes(key)) continue;
    const a = normalizeActions(e.actions);
    if (a) g[key] = a;
    else delete g[key];
  }
  return g;
}

/** The full matrix for Setup → Roles: defaults, with this workspace's edits applied, and which cells were edited. */
export function permissionMatrix(edits: { role: string; module: string; actions: string }[] = []): { module: Module; grants: Partial<Record<Role, string>>; edited: Partial<Record<Role, boolean>> }[] {
  const byRole = new Map(ROLES.map((r) => [r, effectiveGrants(r, edits)]));
  return MODULES.map((module) => {
    const grants: Partial<Record<Role, string>> = {};
    const edited: Partial<Record<Role, boolean>> = {};
    for (const r of ROLES) {
      const a = byRole.get(r)![module];
      if (a) grants[r] = a;
      if ((a ?? "") !== (DEFAULTS[module][r] ?? "")) edited[r] = true;
    }
    return { module, grants, edited };
  });
}

/** Setup → Roles, Module access: per screen and role — switched on, usable with the role's permissions, changed from default. */
export function screenMatrix(edits: { role: string; module: string; actions: string }[] = []): { screen: Screen; on: Partial<Record<Role, boolean>>; available: Partial<Record<Role, boolean>>; edited: Partial<Record<Role, boolean>> }[] {
  const byRole = new Map(ROLES.map((r) => [r, effectiveGrants(r, edits)]));
  return SCREENS.map((screen) => {
    const on: Partial<Record<Role, boolean>> = {};
    const available: Partial<Record<Role, boolean>> = {};
    const edited: Partial<Record<Role, boolean>> = {};
    for (const r of ROLES) {
      const grants = byRole.get(r)!;
      on[r] = !!grants[`screen.${screen}`];
      available[r] = navAvailable({ role: r, grants }).includes(screen);
      if (on[r] !== !!defaultGrants(r)[`screen.${screen}`]) edited[r] = true;
    }
    return { screen, on, available, edited };
  });
}

export function can(who: Who, module: Module, action: Action): boolean {
  const grants = who.grants ?? defaultGrants(who.role);
  return (grants[module] ?? "").includes(action);
}

/** Throws 403 unless the signed-in actor may do this. */
export function requirePermission(ctx: { actor?: Who }, module: Module, action: Action): void {
  if (!ctx.actor || !can(ctx.actor, module, action)) throw forbidden("You don't have permission for this");
}

/**
 * Reassigning leads (bulk "Assign to…", choosing an owner on Create Lead):
 * edit rights on leads AND a scope wider than your own leads. No new matrix
 * letter — "A" in DESIGN §7 means approve, not assign.
 */
export function canReassign(who: Who): boolean {
  return can(who, "leads", "E") && leadScope(who.role) !== "own" && leadScope(who.role) !== "none";
}

/** Which leads a role may see inside its tenant. */
export type LeadScope = "own" | "process" | "tenant" | "none";

export function leadScope(role: Role): LeadScope {
  switch (role) {
    case "super_admin":
    case "admin":
    case "auditor": // process audit: reads every lead, edits none (matrix)
      return "tenant";
    case "project_supervisor":
    case "manager":
    case "process_coordinator":
      return "process";
    case "agent":
      return "own";
    // No lead rights by default (matrix). If a Super Admin grants them (Setup →
    // Roles), they see the processes they're mapped to — never the whole workspace.
    case "client":
    case "trainer":
    case "hr":
    case "accounts":
      return "process";
  }
}

/** Roles that see full phone numbers. Everyone else sees XXXXXX1234 (SECURITY.md §5). */
export function canSeeFullPhone(role: Role): boolean {
  return role === "super_admin" || role === "admin" || role === "project_supervisor" || role === "manager";
}

/** Setup areas; seeing any one of them opens Setup (each tab checks its own). */
const SETUP_MODULES: Module[] = ["config", "users", "import_sources", "webhooks", "integrations", "audit", "employees", "billing"];

/** Modules this actor's permissions can use, before the module-access switches. */
export function navAvailable(who: Who): Screen[] {
  const items: Screen[] = [];
  const scoped = leadScope(who.role) !== "none";
  if (scoped && can(who, "leads", "V")) items.push("console", "leads");
  // Calls log + recordings: anyone who may view interactions (agents: their own calls).
  if (scoped && can(who, "interactions", "V")) items.push("calls");
  if (can(who, "reports", "V")) items.push("dashboard"); // agents: switched off by default (SCREEN_OFF)
  if (SETUP_MODULES.some((m) => can(who, m, "V"))) items.push("admin");
  items.push("soon"); // showcase on sample data — any role
  return items;
}

/** Sidebar entries for this actor: usable AND switched on in Setup → Roles → Module access. */
export function navFor(who: Who): Screen[] {
  const grants = who.grants ?? defaultGrants(who.role);
  return navAvailable(who).filter((s) => grants[`screen.${s}`]);
}

/** Where an actor lands after sign-in. */
export function homeFor(who: Who): string {
  const nav = navFor(who);
  return nav.includes("console") ? "/console" : nav.includes("dashboard") ? "/dashboard" : nav.includes("admin") ? "/admin" : nav.includes("soon") ? "/soon" : "/no-access";
}

/**
 * Where a workspace switch lands: the module the person was on (`from`, the
 * client's path + query), when their role in the new workspace may open it;
 * otherwise homeFor(who). Only the module path survives, plus Setup's
 * `?tab=`: filters, cursors and `?lead=` hold the old workspace's ids. `from`
 * comes from the browser, so anything that isn't a known module path falls
 * back to home (never an open redirect).
 */
export function landingAfterSwitch(who: Who, from: string | undefined): string {
  const m = /^\/(console|leads|calls|dashboard|admin|soon)(?:\/[a-z-]+)?(?:\?(.*))?$/.exec(from ?? "");
  const page = m?.[1] as ReturnType<typeof navFor>[number] | undefined;
  if (!page || !navFor(who).includes(page)) return homeFor(who);
  const tab = page === "admin" ? new URLSearchParams(m![2] ?? "").get("tab") : null;
  return tab && /^[a-z]+$/.test(tab) ? `/admin?tab=${tab}` : `/${page}`;
}
