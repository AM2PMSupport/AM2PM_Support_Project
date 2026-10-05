/**
 * Who may receive a lead right now (DESIGN.md §4). Pure functions.
 *
 * Fixed order (RULE.md §4.3):
 *   active → mapped to the process (and in its pool) → available (and not on
 *   approved Jibble leave today) →
 *   inside working hours → under maxOpenLeads → under daily quota → skills.
 *
 * "Mapped to the process" is enforced by the SQL join on user_processes in
 * assign.ts; everything else is checked here. Working hours use the TENANT
 * timezone, never server time.
 */
import type { AssignmentConfig, User, WorkingHours } from "@/lib/db/schema";

/** Tenant-local weekday (0 = Sun), "HH:mm" and "YYYY-MM-DD" for a moment. */
export function localParts(at: Date, timeZone: string): { weekday: number; hhmm: string; day: string } {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "");
  return { weekday, hhmm: `${p.hour}:${p.minute}`, day: `${p.year}-${p.month}-${p.day}` };
}

export function withinWorkingHours(hours: WorkingHours | undefined, at: Date, timeZone: string): boolean {
  if (!hours) return true; // no hours configured = always open
  const { weekday, hhmm } = localParts(at, timeZone);
  if (!hours.days.includes(weekday)) return false;
  // "HH:mm" strings compare correctly as text.
  return hours.start <= hhmm && hhmm < hours.end;
}

type EligibilityUser = Pick<User, "id" | "status" | "isAvailable" | "openLeads" | "maxOpenLeads" | "dailyQuota" | "skills"> & Partial<Pick<User, "onLeaveOn">>;

export interface EligibilityInput<U extends EligibilityUser> {
  assignment: AssignmentConfig;
  /** Agents already known to be mapped to the process. */
  users: U[];
  dailyCounts: Record<string, number>;
  /** Tags the lead needs for the "skill" method, e.g. ["hindi", "pune"]. */
  requiredSkills?: string[];
  now: Date;
  timeZone: string;
}

/** Returns the same user objects it was given (full type preserved). */
export function eligibleUsers<U extends EligibilityUser>(input: EligibilityInput<U>): U[] {
  const { assignment, users, dailyCounts, requiredSkills = [], now, timeZone } = input;
  if (!withinWorkingHours(assignment.workingHours, now, timeZone)) return [];
  const pool = new Set(assignment.pool ?? []);
  const today = localParts(now, timeZone).day;

  return users.filter((u) => {
    if (u.status !== "active") return false;
    if (pool.size && !pool.has(u.id)) return false;
    if (!u.isAvailable) return false;
    // Approved leave in Jibble today (stamped by the attendance sync, T2.25). A stale stamp from another day doesn't count.
    if (u.onLeaveOn && u.onLeaveOn === today) return false;
    if (u.openLeads >= u.maxOpenLeads) return false;
    if (assignment.method === "number" && (u.dailyQuota ?? 0) <= (dailyCounts[u.id] ?? 0)) return false;
    if (assignment.method === "skill" && !requiredSkills.every((s) => u.skills.includes(s))) return false;
    return true;
  });
}
