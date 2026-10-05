/**
 * Reports — pure helpers, no I/O (DESIGN.md §9 Reports, T3.2).
 *
 * Periods are tenant-local calendar days (yyyy-mm-dd, both ends inclusive);
 * SQL turns them into UTC instants with `at time zone` (RULE.md §12). Live
 * queries cap a range at MAX_DAYS so one click can't scan a year of calls;
 * longer ranges move to the daily_stats rollup (T3.1).
 */
export const PERIODS = ["today", "yesterday", "7d", "30d", "this_month", "last_month", "custom"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_LABEL: Record<Period, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom",
};
export const MAX_DAYS = 92;

export interface Range {
  period: Period;
  from: string; // yyyy-mm-dd, tenant-local, inclusive
  to: string; // yyyy-mm-dd, tenant-local, inclusive
  days: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => fromMs(toMs(d) + n * 86_400_000);
const validDay = (d: string | undefined): d is string => !!d && DAY.test(d) && !Number.isNaN(toMs(d)) && fromMs(toMs(d)) === d;

/** Today's date in a timezone, as yyyy-mm-dd. */
export function localToday(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * URL params → a safe range. Unknown period → last 7 days; a custom range
 * is clamped to [today − MAX_DAYS, today], swapped if reversed, and capped
 * at MAX_DAYS long.
 */
export function resolveRange(q: { period?: string; from?: string; to?: string }, today: string): Range {
  const period: Period = (PERIODS as readonly string[]).includes(q.period ?? "") ? (q.period as Period) : "7d";
  let from: string;
  let to = today;
  switch (period) {
    case "today":
      from = today;
      break;
    case "yesterday":
      from = to = addDays(today, -1);
      break;
    case "7d":
      from = addDays(today, -6);
      break;
    case "30d":
      from = addDays(today, -29);
      break;
    case "this_month":
      from = `${today.slice(0, 8)}01`;
      break;
    case "last_month": {
      to = addDays(`${today.slice(0, 8)}01`, -1);
      from = `${to.slice(0, 8)}01`;
      break;
    }
    case "custom": {
      const a = validDay(q.from) ? q.from : addDays(today, -6);
      const b = validDay(q.to) ? q.to : today;
      [from, to] = a <= b ? [a, b] : [b, a];
      if (to > today) to = today;
      if (from > to) from = to;
      if (toMs(to) - toMs(from) >= MAX_DAYS * 86_400_000) from = addDays(to, -(MAX_DAYS - 1));
      break;
    }
  }
  return { period, from, to, days: Math.round((toMs(to) - toMs(from)) / 86_400_000) + 1 };
}

/** Every day in the range, oldest first (for trend rows with zero days). */
export function daysOf(r: Pick<Range, "from" | "to">): string[] {
  const out: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const pct = (part: number, whole: number): number | null => (whole ? part / whole : null);

/**
 * Calls per hour over an agent's working span (first → last call). Spans
 * under an hour count as one hour, so 5 calls in 10 minutes reads 5/h, not 30/h.
 */
export function perHour(calls: number, activeSec: number): number | null {
  if (!calls) return null;
  return calls / Math.max(activeSec / 3600, 1);
}

/** One agent on one day (from SQL). Times are epoch ms; minute-of-day is tenant-local. */
export interface AgentDay {
  agentId: string;
  name: string;
  day: string;
  login: number | null;
  logout: number | null;
  firstCall: number | null;
  lastCall: number | null;
  firstCallMin: number | null; // minutes after local midnight
  lastCallMin: number | null;
  dialled: number;
  connected: number;
  inboundAnswered: number;
  inboundMissed: number;
  talkSec: number;
  interested: number;
  callbacksSet: number;
  notInterested: number;
  won: number;
  callbacksDue: number;
  callbacksOnTime: number;
}

export interface AgentSummary {
  agentId: string;
  name: string;
  daysActive: number;
  dialled: number;
  connected: number;
  connectRate: number | null;
  inboundAnswered: number;
  inboundMissed: number;
  talkSec: number;
  avgTalkSec: number | null;
  activeSec: number;
  dialledPerHour: number | null;
  connectedPerHour: number | null;
  avgFirstCallMin: number | null;
  avgLastCallMin: number | null;
  interested: number;
  callbacksSet: number;
  notInterested: number;
  won: number;
  conversionRate: number | null; // won ÷ connected
  callbacksDue: number;
  callbacksOnTime: number;
  callbackCompliance: number | null;
}

/** Working span of one day: first → last call. */
export const activeSecOf = (d: Pick<AgentDay, "firstCall" | "lastCall">) => (d.firstCall !== null && d.lastCall !== null ? Math.max(0, (d.lastCall - d.firstCall) / 1000) : 0);

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Agent-day rows → one row per agent over the whole range (sorted by connected, then dialled). */
export function summariseAgents(days: AgentDay[]): AgentSummary[] {
  const by = new Map<string, AgentDay[]>();
  for (const d of days) by.set(d.agentId, [...(by.get(d.agentId) ?? []), d]);
  return [...by.values()]
    .map((ds) => {
      const sum = (k: keyof AgentDay) => ds.reduce((a, d) => a + (d[k] as number), 0);
      const dialled = sum("dialled");
      const connected = sum("connected");
      const talkSec = sum("talkSec");
      // Per-hour rates per day, each day's span floored at 1 h (see perHour), then summed.
      const hours = ds.filter((d) => d.dialled + d.inboundAnswered > 0).reduce((a, d) => a + Math.max(activeSecOf(d) / 3600, 1), 0);
      const won = sum("won");
      const callbacksDue = sum("callbacksDue");
      const callbacksOnTime = sum("callbacksOnTime");
      return {
        agentId: ds[0]!.agentId,
        name: ds[0]!.name,
        daysActive: ds.filter((d) => d.dialled + d.inboundAnswered > 0 || d.login !== null).length,
        dialled,
        connected,
        connectRate: pct(connected, dialled),
        inboundAnswered: sum("inboundAnswered"),
        inboundMissed: sum("inboundMissed"),
        talkSec,
        avgTalkSec: connected + sum("inboundAnswered") ? Math.round(talkSec / (connected + sum("inboundAnswered"))) : null,
        activeSec: ds.reduce((a, d) => a + activeSecOf(d), 0),
        dialledPerHour: dialled && hours ? dialled / hours : null,
        connectedPerHour: connected && hours ? connected / hours : null,
        avgFirstCallMin: avg(ds.flatMap((d) => (d.firstCallMin === null ? [] : [d.firstCallMin]))),
        avgLastCallMin: avg(ds.flatMap((d) => (d.lastCallMin === null ? [] : [d.lastCallMin]))),
        interested: sum("interested"),
        callbacksSet: sum("callbacksSet"),
        notInterested: sum("notInterested"),
        won,
        conversionRate: pct(won, connected),
        callbacksDue,
        callbacksOnTime,
        callbackCompliance: pct(callbacksOnTime, callbacksDue),
      };
    })
    .sort((a, b) => b.connected - a.connected || b.dialled - a.dialled || a.name.localeCompare(b.name));
}

/** Epoch ms → "HH:MM" in a timezone. */
export const timeIn = (ms: number | null, timeZone: string) =>
  ms === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

/** Minutes after midnight → "HH:MM". */
export const clockOf = (min: number | null) => (min === null ? "—" : `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(Math.round(min % 60) % 60).padStart(2, "0")}`);

/** Seconds → "1h 05m" / "4m 10s". */
export function duration(sec: number | null): string {
  if (sec === null) return "—";
  const s = Math.round(sec);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
