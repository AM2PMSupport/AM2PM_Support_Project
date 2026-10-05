/**
 * Attendance — Jibble connection, sync and the platform-side reads
 * (DESIGN.md §11, T2.18–T2.26). The workforce_* tables are platform tables
 * (no tenant_id, app role revoked), so only this module touches them.
 *
 * Sync (syncAttendance): one at a time (Redis lock), parts fail independently
 * and their errors show in Setup.
 *   entries  every poll: clock events since the cursor − 10 min (polls overlap;
 *            INSERT … ON CONFLICT DO NOTHING on the Jibble id), then each
 *            person's state from their newest event
 *   people   daily / on demand: upsert; link to a CRM account by email unless
 *            linked by hand
 *   leave    every 6 h: time off for −7 … +30 days and holidays to year end;
 *            then users.on_leave_on = today (tenant-local) for people on
 *            approved leave, which assignment skips (T2.25)
 * Triggers: the tick job (every 5 min on Vercel Pro) and, while crons are
 * daily (Hobby), page views of Attendance / Floor via after() when the last
 * poll is older than 5 min (syncAttendanceIfStale).
 *
 * Reads take account ids that the caller got from its OWN workspace (via
 * withTenantRead), so a workspace only ever sees its members' attendance.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { workforceConnections, workforceEntries, workforceHolidays, workforceLeave, workforcePeople } from "@/lib/db/schema";
import { platformDb } from "@/lib/platform-admin/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { jibble, type JibbleCredentials } from "@/lib/providers/workforce/jibble";
import { redis } from "@/lib/redis/client";
import { log } from "@/lib/log";
import { forbidden, notFound } from "@/lib/http/errors";

const PROVIDER = "jibble";
const POLL_MS = 5 * 60_000;
const PEOPLE_MS = 24 * 3_600_000;
const LEAVE_MS = 6 * 3_600_000;
const OVERLAP_MS = 10 * 60_000;
const FIRST_SYNC_DAYS = 3;
const LOCK = "platform:attendance:sync";

const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function connection() {
  const [c] = await platformDb().select().from(workforceConnections).where(eq(workforceConnections.provider, PROVIDER));
  return c ?? null;
}

function creds(credentialsEnc: string): JibbleCredentials {
  return JSON.parse(decrypt(credentialsEnc)) as JibbleCredentials;
}

// ------------------------------------------------------------ connection (Super Admin)

export const JibbleInput = z.object({ clientId: z.string().trim().min(8).max(200), clientSecret: z.string().trim().min(8).max(400) });

type Actor = { actor: { role: string }; accountId: string };
const superAdminOnly = (ctx: Actor) => {
  // A fixed rule, not a matrix cell: one Jibble org serves every workspace.
  if (ctx.actor.role !== "super_admin") throw forbidden("Only a Super Admin can connect Jibble");
};

export async function saveJibble(ctx: Actor, raw: unknown): Promise<void> {
  superAdminOnly(ctx);
  const input = JibbleInput.parse(raw);
  const credentialsEnc = encrypt(JSON.stringify(input));
  await platformDb()
    .insert(workforceConnections)
    .values({ provider: PROVIDER, credentialsEnc, updatedBy: ctx.accountId || null })
    .onConflictDoUpdate({ target: workforceConnections.provider, set: { credentialsEnc, status: "active", lastErrors: {}, updatedBy: ctx.accountId || null, updatedAt: new Date() } });
}

export async function disconnectJibble(ctx: Actor): Promise<void> {
  superAdminOnly(ctx);
  await platformDb().delete(workforceConnections).where(eq(workforceConnections.provider, PROVIDER));
}

export async function testJibble(ctx: Actor) {
  superAdminOnly(ctx);
  const c = await connection();
  if (!c) throw notFound("Connect Jibble first");
  return jibble.test(creds(c.credentialsEnc));
}

/** Setup → Attendance: status (no secrets) + people Jibble has that no CRM login matches. */
export async function jibbleStatus() {
  const c = await connection();
  const db = platformDb();
  const [counts] = await db
    .select({ people: sql<number>`count(*)::int`, linked: sql<number>`count(${workforcePeople.accountId})::int` })
    .from(workforcePeople);
  const unmatched = await db
    .select({ id: workforcePeople.id, fullName: workforcePeople.fullName, email: workforcePeople.email, code: workforcePeople.code })
    .from(workforcePeople)
    .where(sql`${workforcePeople.accountId} is null and coalesce(${workforcePeople.status}, '') not ilike 'archived'`)
    .orderBy(workforcePeople.fullName)
    .limit(200);
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
  return {
    connected: !!c,
    status: c?.status ?? null,
    entriesSyncedAt: iso(c?.entriesSyncedAt),
    peopleSyncedAt: iso(c?.peopleSyncedAt),
    leaveSyncedAt: iso(c?.leaveSyncedAt),
    errors: c?.lastErrors ?? {},
    people: counts?.people ?? 0,
    linked: counts?.linked ?? 0,
    unmatched,
  };
}

/** Link a Jibble person to a CRM login by hand (emails differ). accountId comes from the caller's own workspace. */
export async function linkPerson(ctx: Actor, personId: string, accountId: string | null): Promise<void> {
  superAdminOnly(ctx);
  const [p] = await platformDb()
    .update(workforcePeople)
    .set({ accountId, linkedBy: accountId ? "manual" : null, updatedAt: new Date() })
    .where(eq(workforcePeople.id, personId))
    .returning({ id: workforcePeople.id });
  if (!p) throw notFound("Jibble person not found");
}

// ------------------------------------------------------------ sync

export async function syncAttendance(opts: { force?: boolean } = {}): Promise<Record<string, string> | null> {
  const c = await connection();
  if (!c) return null;
  const locked = await redis()
    .set(LOCK, "1", { nx: true, ex: 120 })
    .catch(() => "OK");
  if (locked !== "OK") return { skipped: "another sync is running" };
  const cr = creds(c.credentialsEnc);
  const db = platformDb();
  const now = new Date();
  const result: Record<string, string> = {};
  const errors: Record<string, string> = { ...c.lastErrors };
  const part = async (name: string, due: boolean, fn: () => Promise<string>) => {
    if (!due) return;
    try {
      result[name] = await fn();
      delete errors[name];
    } catch (err) {
      errors[name] = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      result[name] = "failed";
      log.warn("attendance sync part failed", { part: name, err });
    }
  };
  try {
    const old = (d: Date | null, ms: number) => opts.force || !d || now.getTime() - d.getTime() > ms;

    await part("people", old(c.peopleSyncedAt, PEOPLE_MS), async () => {
      const people = await jibble.people(cr);
      for (const p of people) {
        await db
          .insert(workforcePeople)
          .values({ id: p.id, email: p.email, fullName: p.fullName, code: p.code, status: p.status })
          .onConflictDoUpdate({ target: workforcePeople.id, set: { email: p.email, fullName: p.fullName, code: p.code, status: p.status, updatedAt: now } });
      }
      // Link by email (accounts.email is stored lower-case); hand-made links are kept.
      await db.execute(sql`
        update workforce_people p set account_id = a.id, linked_by = 'email'
        from accounts a
        where p.email is not null and a.email = lower(p.email) and p.linked_by is distinct from 'manual' and p.account_id is distinct from a.id`);
      await db.update(workforceConnections).set({ peopleSyncedAt: now }).where(eq(workforceConnections.provider, PROVIDER));
      return `${people.length} people`;
    });

    await part("entries", true, async () => {
      const since = c.entriesCursor ? new Date(c.entriesCursor.getTime() - OVERLAP_MS) : new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000);
      const entries = await jibble.entriesSince(cr, since);
      if (entries.length) {
        for (let i = 0; i < entries.length; i += 500) {
          await db
            .insert(workforceEntries)
            .values(entries.slice(i, i + 500).map((e) => ({ id: e.id, personId: e.personId, type: e.type, at: e.at, belongsToDate: e.belongsToDate })))
            .onConflictDoNothing();
        }
        // Each person's state = their newest event, unless we already hold a newer one.
        await db.execute(sql`
          update workforce_people p set state = case e.type when 'In' then 'in' when 'StartBreak' then 'break' when 'Out' then 'out' else p.state end, state_at = e.at, updated_at = now()
          from (select distinct on (person_id) person_id, type, at from workforce_entries
                where at >= ${since} order by person_id, at desc) e
          where p.id = e.person_id and (p.state_at is null or e.at >= p.state_at)`);
      }
      const newest = entries.reduce((m, e) => (e.at > m ? e.at : m), c.entriesCursor ?? since);
      await db.update(workforceConnections).set({ entriesCursor: newest, entriesSyncedAt: now }).where(eq(workforceConnections.provider, PROVIDER));
      return `${entries.length} clock events`;
    });

    await part("leave", old(c.leaveSyncedAt, LEAVE_MS), async () => {
      const from = dayOffset(-7);
      const to = dayOffset(30);
      const leave = await jibble.leave(cr, from, to);
      for (const l of leave) {
        await db
          .insert(workforceLeave)
          .values({ ...l, syncedAt: now })
          .onConflictDoUpdate({ target: workforceLeave.id, set: { startDate: l.startDate, endDate: l.endDate, status: l.status, kind: l.kind, syncedAt: now } });
      }
      // Cancelled / deleted in Jibble: no longer returned for the window → drop.
      await db.delete(workforceLeave).where(and(lte(workforceLeave.startDate, to), gte(workforceLeave.endDate, from), sql`${workforceLeave.syncedAt} < ${now}`));
      await markLeaveToday();
      await db.update(workforceConnections).set({ leaveSyncedAt: now }).where(eq(workforceConnections.provider, PROVIDER));
      return `${leave.length} time off`;
    });

    await part("holidays", old(c.leaveSyncedAt, LEAVE_MS), async () => {
      const holidays = await jibble.holidays(cr, dayOffset(-1), `${dayOffset(0).slice(0, 4)}-12-31`);
      if (holidays.length) await db.insert(workforceHolidays).values(holidays).onConflictDoNothing();
      return `${holidays.length} holidays`;
    });
  } finally {
    await db
      .update(workforceConnections)
      .set({ lastErrors: errors, status: errors.entries || errors.people ? "error" : "active" })
      .where(eq(workforceConnections.provider, PROVIDER));
    await redis()
      .del(LOCK)
      .catch(() => undefined);
  }
  return result;
}

/** Stamp users.on_leave_on with each workspace's local today for people on approved leave; clear the rest. */
async function markLeaveToday(): Promise<void> {
  const onLeave = sql`exists (
    select 1 from workforce_people p join workforce_leave l on l.person_id = p.id
    where p.account_id = u.account_id and l.status ilike 'approved'
      and (now() at time zone t.timezone)::date between l.start_date and l.end_date)`;
  await platformDb().execute(sql`
    update users u set on_leave_on = case when ${onLeave} then to_char(now() at time zone t.timezone, 'YYYY-MM-DD') else null end
    from tenants t
    where t.id = u.tenant_id and u.account_id is not null
      and (u.on_leave_on is not null or ${onLeave})`);
}

/** Poll when the last one is older than 5 min — called from page views (after()) and the tick. */
export async function syncAttendanceIfStale(): Promise<void> {
  const c = await connection();
  if (!c || (c.entriesSyncedAt && Date.now() - c.entriesSyncedAt.getTime() < POLL_MS)) return;
  await syncAttendance();
}

// ------------------------------------------------------------ reads (caller passes its own members' account ids)

export async function attendanceFor(accountIds: string[], from: string, to: string) {
  const c = await connection();
  if (!accountIds.length) return { connected: !!c, syncedAt: c?.entriesSyncedAt?.getTime() ?? null, people: [], entries: [], leave: [] };
  const db = platformDb();
  const people = await db
    .select({ id: workforcePeople.id, accountId: workforcePeople.accountId, state: workforcePeople.state, stateAt: workforcePeople.stateAt, code: workforcePeople.code })
    .from(workforcePeople)
    .where(inArray(workforcePeople.accountId, accountIds));
  const ids = people.map((p) => p.id);
  const [entries, leave] = ids.length
    ? await Promise.all([
        db
          .select({ personId: workforceEntries.personId, type: workforceEntries.type, at: workforceEntries.at, day: workforceEntries.belongsToDate })
          .from(workforceEntries)
          .where(and(inArray(workforceEntries.personId, ids), gte(workforceEntries.belongsToDate, from), lte(workforceEntries.belongsToDate, to)))
          .orderBy(workforceEntries.at),
        db
          .select({ personId: workforceLeave.personId, startDate: workforceLeave.startDate, endDate: workforceLeave.endDate, status: workforceLeave.status, kind: workforceLeave.kind })
          .from(workforceLeave)
          .where(and(inArray(workforceLeave.personId, ids), lte(workforceLeave.startDate, to), gte(workforceLeave.endDate, from))),
      ])
    : [[], []];
  return { connected: !!c, syncedAt: c?.entriesSyncedAt?.getTime() ?? null, people, entries, leave };
}

export async function holidaysBetween(from: string, to: string) {
  return platformDb()
    .select()
    .from(workforceHolidays)
    .where(and(gte(workforceHolidays.date, from), lte(workforceHolidays.date, to)))
    .orderBy(workforceHolidays.date);
}
