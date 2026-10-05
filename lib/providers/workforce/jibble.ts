/**
 * Jibble adapter (DESIGN.md §11, T2.18) — read-only, OAuth2 client credentials.
 *
 *   Token        POST https://identity.prod.jibble.io/connect/token
 *                form: grant_type=client_credentials, client_id, client_secret
 *   People       GET  https://workspace.prod.jibble.io/v1/People            (OData)
 *   Time entries GET  https://time-tracking.prod.jibble.io/v1/TimeEntries    (OData)
 *                $select=id,type,time,belongsToDate,personId  type ∈ In | Out | StartBreak
 *                (confirmed against Jibble's API docs 2026-10-06)
 *   Time off     GET  https://time-tracking.prod.jibble.io/v1/TimeOffIntervals (OData)
 *   Holidays     GET  https://workspace.prod.jibble.io/v1/CalendarEvents      (OData)
 *
 * People, time off and holidays field names are read tolerantly (several
 * spellings, like the CallerDesk adapter) and every Jibble-specific name lives
 * in this file, so a fix after the first live test is a one-line change.
 * Setup → Attendance → Test connection reports which endpoints answered.
 * The token (≈1 h) is cached per instance in memory — never in Redis or logs.
 * Paging: $top/$skip, 100 per page, capped so one poll can't run away.
 */
export interface JibbleCredentials {
  clientId: string;
  clientSecret: string;
}

export interface JibblePerson {
  id: string;
  email: string | null;
  fullName: string;
  code: string | null;
  status: string | null;
}

export interface JibbleEntry {
  id: string;
  personId: string;
  type: string;
  at: Date;
  belongsToDate: string;
}

export interface JibbleLeave {
  id: string;
  personId: string;
  startDate: string;
  endDate: string;
  status: string;
  kind: string | null;
}

export interface JibbleHoliday {
  date: string;
  name: string;
}

const TOKEN_URL = "https://identity.prod.jibble.io/connect/token";
const WORKSPACE = "https://workspace.prod.jibble.io/v1";
const TIME = "https://time-tracking.prod.jibble.io/v1";
const PAGE = 100;
const MAX_PAGES = 50; // 5,000 rows per call at most
const TIMEOUT_MS = 15_000;

export class JibbleError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Obj = Record<string, unknown>;
const str = (o: Obj, ...names: string[]): string | null => {
  for (const n of names) {
    const v = o[n];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
};
const day = (v: string | null) => (v ? v.slice(0, 10) : null);

const tokens = new Map<string, { token: string; until: number }>();

async function token(c: JibbleCredentials): Promise<string> {
  const hit = tokens.get(c.clientId);
  if (hit && hit.until > Date.now()) return hit.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res) throw new JibbleError("Could not reach Jibble");
  if (!res.ok) throw new JibbleError(res.status === 400 || res.status === 401 ? "Jibble rejected the Client ID / Secret" : `Jibble sign-in failed (HTTP ${res.status})`, res.status);
  const body = (await res.json().catch(() => ({}))) as Obj;
  const access = str(body, "access_token");
  if (!access) throw new JibbleError("Jibble returned no access token");
  // Refresh a minute early.
  tokens.set(c.clientId, { token: access, until: Date.now() + (Number(body.expires_in ?? 3600) - 60) * 1000 });
  return access;
}

/** All pages of an OData collection. */
async function list(c: JibbleCredentials, url: string, query: Record<string, string>): Promise<Obj[]> {
  const out: Obj[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ ...query, $top: String(PAGE), $skip: String(page * PAGE) });
    const res = await fetch(`${url}?${q}`, { headers: { authorization: `Bearer ${await token(c)}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!res) throw new JibbleError("Could not reach Jibble");
    if (res.status === 401) tokens.delete(c.clientId);
    if (!res.ok) throw new JibbleError(res.status === 429 ? "Jibble rate limit — try again shortly" : `HTTP ${res.status}`, res.status);
    const body = (await res.json().catch(() => ({}))) as Obj;
    const value = Array.isArray(body.value) ? (body.value as Obj[]) : [];
    out.push(...value);
    if (value.length < PAGE) break;
  }
  return out;
}

export function parsePerson(o: Obj): JibblePerson | null {
  const id = str(o, "id", "personId");
  if (!id) return null;
  return {
    id,
    email: str(o, "email", "emailAddress", "workEmail")?.toLowerCase() ?? null,
    fullName: str(o, "fullName", "fullname", "name", "displayName") ?? ([str(o, "firstName"), str(o, "lastName")].filter(Boolean).join(" ") || "—"),
    code: str(o, "code", "employeeCode"),
    status: str(o, "status"),
  };
}

export function parseEntry(o: Obj): JibbleEntry | null {
  const id = str(o, "id");
  const personId = str(o, "personId");
  const type = str(o, "type");
  const time = str(o, "time");
  if (!id || !personId || !type || !time || Number.isNaN(Date.parse(time))) return null;
  return { id, personId, type, at: new Date(time), belongsToDate: day(str(o, "belongsToDate")) ?? time.slice(0, 10) };
}

export function parseLeave(o: Obj): JibbleLeave | null {
  const id = str(o, "id", "timeOffId", "requestId");
  const personId = str(o, "personId");
  const startDate = day(str(o, "startDate", "start", "from", "date"));
  const endDate = day(str(o, "endDate", "end", "to", "date")) ?? startDate;
  if (!id || !personId || !startDate || !endDate) return null;
  return { id, personId, startDate, endDate, status: str(o, "status", "approvalStatus") ?? "Approved", kind: str(o, "policyName", "timeOffPolicyName", "type", "kind") };
}

export function parseHoliday(o: Obj): JibbleHoliday | null {
  const date = day(str(o, "date", "startDate", "start"));
  const name = str(o, "name", "title", "description");
  return date && name ? { date, name } : null;
}

const keep = <T>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null);

export const jibble = {
  async people(c: JibbleCredentials): Promise<JibblePerson[]> {
    return keep((await list(c, `${WORKSPACE}/People`, {})).map(parsePerson));
  },
  /** Clock events at or after `since`, oldest first. */
  async entriesSince(c: JibbleCredentials, since: Date): Promise<JibbleEntry[]> {
    const rows = await list(c, `${TIME}/TimeEntries`, {
      $filter: `time ge ${since.toISOString()} and status ne 'Archived'`,
      $orderby: "time asc",
      $select: "id,type,time,belongsToDate,personId",
    });
    return keep(rows.map(parseEntry));
  },
  async leave(c: JibbleCredentials, from: string, to: string): Promise<JibbleLeave[]> {
    return keep((await list(c, `${TIME}/TimeOffIntervals`, { $filter: `endDate ge ${from} and startDate le ${to}` })).map(parseLeave));
  },
  async holidays(c: JibbleCredentials, from: string, to: string): Promise<JibbleHoliday[]> {
    return keep((await list(c, `${WORKSPACE}/CalendarEvents`, { $filter: `date ge ${from} and date le ${to}` })).map(parseHoliday));
  },
  /** Which parts answer — for Setup → Test connection. Never throws. */
  async test(c: JibbleCredentials): Promise<{ part: string; ok: boolean; detail: string }[]> {
    const today = new Date().toISOString().slice(0, 10);
    const run = async (part: string, fn: () => Promise<unknown[]>) => {
      try {
        const rows = await fn();
        return { part, ok: true, detail: `${rows.length} found` };
      } catch (err) {
        return { part, ok: false, detail: err instanceof Error ? err.message : "failed" };
      }
    };
    try {
      await token(c);
    } catch (err) {
      return [{ part: "Sign-in", ok: false, detail: err instanceof Error ? err.message : "failed" }];
    }
    return [
      { part: "Sign-in", ok: true, detail: "Client ID / Secret accepted" },
      await run("People", () => jibble.people(c)),
      await run("Clock events (today)", () => jibble.entriesSince(c, new Date(`${today}T00:00:00Z`))),
      await run("Time off", () => jibble.leave(c, today, today)),
      await run("Holidays", () => jibble.holidays(c, today, `${today.slice(0, 4)}-12-31`)),
    ];
  },
};
