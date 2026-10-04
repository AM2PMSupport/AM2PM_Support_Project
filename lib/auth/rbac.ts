/**
 * Role-based access control (DESIGN.md §7) — pure, unit-tested.
 *
 * Actions: V view · C create · E edit · D delete · A approve · X export.
 * The matrix is the single source of truth for both API checks
 * (requirePermission) and UI (which nav items / buttons a role sees).
 *
 * Data scope is separate from permission: an agent may "VE" leads, but only
 * their OWN (leadScope). Tenant isolation itself is enforced by Postgres RLS;
 * these rules narrow access further inside a tenant.
 */
import { forbidden } from "@/lib/http/errors";
import type { Role } from "@/lib/db/schema";

export type Module =
  | "config" // processes, dispositions, custom fields, workspace settings
  | "users"
  | "leads"
  | "interactions"
  | "callbacks"
  | "import_sources"
  | "webhooks"
  | "reports"
  | "integrations"
  | "backups"
  | "audit";

export type Action = "V" | "C" | "E" | "D" | "A" | "X";

type Matrix = Record<Module, Partial<Record<Role, string>>>;

const MATRIX: Matrix = {
  config: { super_admin: "VCEDAX", admin: "VCE", project_supervisor: "V", manager: "V" },
  users: { super_admin: "VCEDAX", admin: "VCEDX", project_supervisor: "VE", manager: "VE", process_coordinator: "V" },
  leads: { super_admin: "VCEDAX", admin: "VCEDX", project_supervisor: "VCEAX", manager: "VCEAX", process_coordinator: "VCE", client: "V", agent: "VE" },
  interactions: { super_admin: "VX", admin: "VX", project_supervisor: "VX", manager: "VX", process_coordinator: "V", client: "V", agent: "VC" },
  callbacks: { super_admin: "VCEDX", admin: "VCEDX", project_supervisor: "VCEA", manager: "VCEA", process_coordinator: "VCE", agent: "VCE" },
  import_sources: { super_admin: "VCED", admin: "VCED", project_supervisor: "V", manager: "V" },
  webhooks: { super_admin: "VCEDX", admin: "VCED", project_supervisor: "VE", manager: "V" },
  reports: { super_admin: "VX", admin: "VX", project_supervisor: "VX", manager: "VX", process_coordinator: "V", trainer: "V", client: "V", agent: "V" },
  integrations: { super_admin: "VCED", admin: "VCE" },
  backups: { super_admin: "VCEDAX", admin: "VCX", project_supervisor: "V", manager: "V", client: "V" },
  audit: { super_admin: "V", admin: "V" },
};

/** The whole matrix, read-only, for Setup → Roles & permissions. */
export function permissionMatrix(): { module: Module; grants: Partial<Record<Role, string>> }[] {
  return (Object.keys(MATRIX) as Module[]).map((module) => ({ module, grants: MATRIX[module] }));
}

export function can(role: Role, module: Module, action: Action): boolean {
  return (MATRIX[module][role] ?? "").includes(action);
}

/** Throws 403 unless the signed-in role may do this. */
export function requirePermission(ctx: { actor?: { role: Role } }, module: Module, action: Action): void {
  if (!ctx.actor || !can(ctx.actor.role, module, action)) throw forbidden("You don't have permission for this");
}

/**
 * Reassigning leads (bulk "Assign to…", choosing an owner on Create Lead):
 * edit rights on leads AND a scope wider than your own leads. No new matrix
 * letter — "A" in DESIGN §7 means approve, not assign.
 */
export function canReassign(role: Role): boolean {
  return can(role, "leads", "E") && leadScope(role) !== "own" && leadScope(role) !== "none";
}

/** Which leads a role may see inside its tenant. */
export type LeadScope = "own" | "process" | "tenant" | "none";

export function leadScope(role: Role): LeadScope {
  switch (role) {
    case "super_admin":
    case "admin":
      return "tenant";
    case "project_supervisor":
    case "manager":
    case "process_coordinator":
      return "process";
    case "agent":
      return "own";
    // Client portal (cross-tenant, read-only) is Phase 3 (T3.5); trainers work in LMS (Phase 4).
    case "client":
    case "trainer":
      return "none";
  }
}

/** Roles that see full phone numbers. Everyone else sees XXXXXX1234 (SECURITY.md §5). */
export function canSeeFullPhone(role: Role): boolean {
  return role === "super_admin" || role === "admin" || role === "project_supervisor" || role === "manager";
}

/** Sidebar entries per role. */
export function navFor(role: Role): ("console" | "leads" | "calls" | "dashboard" | "admin")[] {
  const items: ("console" | "leads" | "calls" | "dashboard" | "admin")[] = [];
  if (leadScope(role) !== "none") items.push("console", "leads");
  // Calls log + recordings: anyone who may view interactions (agents: their own calls).
  if (can(role, "interactions", "V") && leadScope(role) !== "none") items.push("calls");
  if (can(role, "reports", "V") && role !== "agent") items.push("dashboard");
  if (can(role, "config", "V")) items.push("admin");
  return items;
}

/** Where a role lands after sign-in. */
export function homeFor(role: Role): string {
  const nav = navFor(role);
  return nav.includes("console") ? "/console" : nav.includes("dashboard") ? "/dashboard" : "/no-access";
}

/**
 * Where a workspace switch lands: the module the person was on (`from`, the
 * client's path + query), when their role in the new workspace may open it;
 * otherwise homeFor(role). Only the module path survives, plus Setup's
 * `?tab=`: filters, cursors and `?lead=` hold the old workspace's ids. `from`
 * comes from the browser, so anything that isn't a known module path falls
 * back to home (never an open redirect).
 */
export function landingAfterSwitch(role: Role, from: string | undefined): string {
  const m = /^\/(console|leads|calls|dashboard|admin)(?:\?(.*))?$/.exec(from ?? "");
  const page = m?.[1] as ReturnType<typeof navFor>[number] | undefined;
  if (!page || !navFor(role).includes(page)) return homeFor(role);
  const tab = page === "admin" ? new URLSearchParams(m![2] ?? "").get("tab") : null;
  return tab && /^[a-z]+$/.test(tab) ? `/admin?tab=${tab}` : `/${page}`;
}
