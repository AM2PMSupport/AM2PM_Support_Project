/**
 * Attendance maths — pure, no I/O (DESIGN.md §11, T2.20–T2.23).
 *
 * Jibble clock events are In, Out and StartBreak (a break ends with the next
 * In). One person's events for one day → first in, last out, worked time,
 * break time. Presence older than STALE_MS (10 min, longer than the 5-min
 * poll) is "unknown", never "out" — so a stopped sync can't make the whole
 * floor look clocked out (and assignment ignores attendance rather than
 * assigning nobody).
 */
export type ClockType = "In" | "Out" | "StartBreak";
export type Presence = "in" | "break" | "out" | "unknown";
export const STALE_MS = 10 * 60_000;
export const IDLE_MS = 30 * 60_000;

export interface ClockEvent {
  type: string;
  at: number; // epoch ms
}

export interface AttendanceDay {
  firstIn: number | null;
  lastOut: number | null;
  workedSec: number;
  breakSec: number;
  /** Still clocked in (or on break) at the end of the events. */
  open: boolean;
}

/** Latest clock event → presence. */
export function presenceOf(type: string | null | undefined): Exclude<Presence, "unknown"> | null {
  if (type === "In") return "in";
  if (type === "StartBreak") return "break";
  if (type === "Out") return "out";
  return null;
}

/**
 * Walks the events in time order. Work runs from In to the next StartBreak /
 * Out; a break from StartBreak to the next In / Out. An open interval at the
 * end counts up to `until` (now for today; omit for past days → not counted).
 */
export function computeDay(events: ClockEvent[], until?: number): AttendanceDay {
  const es = [...events].sort((a, b) => a.at - b.at);
  let firstIn: number | null = null;
  let lastOut: number | null = null;
  let workedMs = 0;
  let breakMs = 0;
  let mode: "work" | "break" | null = null;
  let since = 0;
  const close = (at: number) => {
    if (mode === "work") workedMs += Math.max(0, at - since);
    if (mode === "break") breakMs += Math.max(0, at - since);
  };
  for (const e of es) {
    if (e.type === "In") {
      if (firstIn === null) firstIn = e.at;
      close(e.at);
      mode = "work";
      since = e.at;
    } else if (e.type === "StartBreak") {
      close(e.at);
      mode = "break";
      since = e.at;
    } else if (e.type === "Out") {
      close(e.at);
      mode = null;
      lastOut = e.at;
    }
  }
  if (mode && until !== undefined) close(Math.max(until, since));
  return { firstIn, lastOut, workedSec: Math.round(workedMs / 1000), breakSec: Math.round(breakMs / 1000), open: mode !== null };
}

/** Presence as shown: unknown when the last successful poll is too old (or never ran). */
export function shownPresence(state: string | null | undefined, syncedAt: number | null, now: number): Presence {
  if (syncedAt === null || now - syncedAt > STALE_MS) return "unknown";
  return presenceOf(state === "in" ? "In" : state === "break" ? "StartBreak" : state === "out" ? "Out" : null) ?? "out";
}

export type Mismatch = "calls_not_clocked_in" | "calls_on_break" | "idle_clocked_in";
export const MISMATCH_LABEL: Record<Mismatch, string> = {
  calls_not_clocked_in: "On calls but not clocked in",
  calls_on_break: "Taking calls on a Jibble break",
  idle_clocked_in: "Clocked in, no calls for 30+ min",
};

/**
 * Alerts for supervisors (T2.21). Only for people who take calls, and only
 * when presence is known.
 */
export function mismatches(p: { presence: Presence; stateAt: number | null; lastCallAt: number | null; takesCalls: boolean }, now: number): Mismatch[] {
  if (!p.takesCalls || p.presence === "unknown") return [];
  const out: Mismatch[] = [];
  const recentCall = p.lastCallAt !== null && now - p.lastCallAt < IDLE_MS;
  if (p.presence === "out" && recentCall) out.push("calls_not_clocked_in");
  if (p.presence === "break" && p.lastCallAt !== null && p.stateAt !== null && p.lastCallAt > p.stateAt) out.push("calls_on_break");
  if (p.presence === "in" && p.stateAt !== null && now - Math.max(p.stateAt, p.lastCallAt ?? 0) >= IDLE_MS) out.push("idle_clocked_in");
  return out;
}

/** Is `day` (yyyy-mm-dd) inside an approved leave? */
export function onLeave(leaves: { startDate: string; endDate: string; status: string }[], day: string): boolean {
  return leaves.some((l) => /^approved$/i.test(l.status) && l.startDate <= day && day <= l.endDate);
}
