/**
 * Nightly per-workspace backups (T1.43–T1.44, ARCHITECTURE.md §7).
 *
 *   runBackups(deadline)  cron `backups` (01:30 IST) and the tick:
 *     1. create today's cron snapshot for every active workspace whose local
 *        time is past 01:00 (INSERT … ON CONFLICT DO NOTHING on (tenant, day))
 *     2. work through running snapshots, oldest first, until the deadline
 *   runSnapshot  every table with a tenant_id (plus the workspace's own row),
 *     read on a replica under RLS in primary-key order, 5,000 rows per file,
 *     sealed with the snapshot's data key (lib/backups/format.ts) into the
 *     separate backup store. Progress (cursor, files, size) is saved after
 *     every file, so a big workspace continues in the next run instead of
 *     hitting the 60 s limit; a Redis lock keeps two runs off one snapshot.
 *   Done → `backup.completed` event, old snapshots pruned per backup_policies
 *   (default 7 daily / 4 weekly / 3 monthly). Failed → `backup.failed` event
 *   + an in-app alert to the workspace's Super Admins.
 * Restore (T3.8) reads files back with readSnapshotTable.
 */
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { backupPolicies, backupSnapshots, tenants, users } from "@/lib/db/schema";
import { platformDb } from "@/lib/platform-admin/db";
import { contextForTenantId } from "@/lib/platform-admin/tenants";
import { withTenant, withTenantRead } from "@/lib/db/tenant";
import { decrypt, encrypt, sha256Hex } from "@/lib/crypto";
import { newDataKey, openChunk, pruneList, sealChunk } from "@/lib/backups/format";
import { backupStoreConfigured, deleteBackupFiles, putBackupFile, readBackupFile } from "@/lib/backups/store";
import { writeOutbox } from "@/lib/events/outbox";
import { notify } from "@/lib/notifications";
import { localToday } from "@/lib/reports/period";
import { redis } from "@/lib/redis/client";
import { log } from "@/lib/log";

export const BATCH = 5_000;
const SAFETY_MS = 8_000;
const START_HOUR = 1;
/**
 * Never backed up: the backup bookkeeping itself and transient, high-volume
 * delivery logs (ARCHITECTURE.md §7 "Excluded"; they expire in 30–90 days anyway).
 */
const SKIP = new Set(["backup_snapshots", "outbox", "webhook_events", "webhook_deliveries"]);
const DEFAULT_POLICY = { keepDaily: 7, keepWeekly: 4, keepMonthly: 3 };

type Snapshot = typeof backupSnapshots.$inferSelect;
const hourIn = (tz: string, at: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(at)) % 24;

/** Workspace tables (have tenant_id) and their primary keys, in a stable order. */
export async function backupTables(): Promise<{ name: string; pk: string[] }[]> {
  const rows = (
    await platformDb().execute(sql`
      select c.relname as name, array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum)) as pk
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
      where i.indisprimary and n.nspname = 'public'
        and exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'tenant_id')
      group by c.relname
      order by c.relname`)
  ).rows as { name: string; pk: string[] | string }[];
  // node-postgres returns text[] as an array; PGlite may return "{a,b}".
  const arr = (v: string[] | string) => (Array.isArray(v) ? v : v.replace(/^{|}$/g, "").split(","));
  return rows.filter((r) => !SKIP.has(r.name)).map((r) => ({ name: r.name, pk: arr(r.pk) }));
}

/** Create today's cron snapshots (idempotent), then run unfinished ones until the deadline. */
export async function runBackups(deadline: number, now = new Date(), batch = BATCH): Promise<string> {
  if (!backupStoreConfigured()) return "backup store not configured";
  const db = platformDb();
  const ws = await db.select({ id: tenants.id, timezone: tenants.timezone }).from(tenants).where(inArray(tenants.status, ["active", "trial"]));
  for (const w of ws) {
    if (hourIn(w.timezone, now) < START_HOUR) continue;
    await db
      .insert(backupSnapshots)
      .values({ tenantId: w.id, trigger: "cron", day: localToday(w.timezone, now), keyEnc: encrypt(newDataKey().toString("base64")), cursor: { table: 0, after: null, chunk: 0 } })
      .onConflictDoNothing({ target: [backupSnapshots.tenantId, backupSnapshots.day], where: sql`${backupSnapshots.trigger} = 'cron'` });
  }
  const running = await db.select().from(backupSnapshots).where(eq(backupSnapshots.status, "running")).orderBy(asc(backupSnapshots.startedAt)).limit(50);
  const out = { done: 0, partial: 0, failed: 0 };
  for (const s of running) {
    if (Date.now() > deadline - SAFETY_MS) break;
    out[await runSnapshot(s, deadline, batch)]++;
  }
  return `${out.done} done, ${out.partial} in progress, ${out.failed} failed`;
}

/** Back up one snapshot as far as the deadline allows. */
export async function runSnapshot(s: Snapshot, deadline: number, batch = BATCH): Promise<"done" | "partial" | "failed"> {
  const lock = `backup:lock:${s.id}`;
  if ((await redis().set(lock, "1", { nx: true, ex: 70 }).catch(() => "OK")) !== "OK") return "partial";
  const db = platformDb();
  const { ctx, tenant } = await contextForTenantId(s.tenantId);
  try {
    const key = Buffer.from(decrypt(s.keyEnc ?? ""), "base64");
    const tables = await backupTables();
    let cur = s.cursor ?? { table: 0, after: null, chunk: 0 };
    const files = { ...s.files };
    let size = s.sizeBytes;
    const base = `backups/${s.tenantId}/${s.day ?? s.startedAt.toISOString().slice(0, 10)}-${s.id}`;
    const write = async (name: string, rows: unknown[]) => {
      const buf = sealChunk(rows, key);
      const path = `${base}/${name}.amb`;
      await putBackupFile(path, buf);
      files[name] = { rows: rows.length, bytes: buf.length, sha256: sha256Hex(buf), key: path };
      size += buf.length;
    };
    if (!files["tenants.0"]) await write("tenants.0", [tenant]);

    while (cur.table < tables.length) {
      if (Date.now() > deadline - SAFETY_MS) {
        await db.update(backupSnapshots).set({ cursor: cur, files, sizeBytes: size }).where(eq(backupSnapshots.id, s.id));
        return "partial";
      }
      const t = tables[cur.table]!;
      const cols = sql.join(t.pk.map((c) => sql.identifier(c)), sql`, `);
      const after = cur.after ? sql`where (${cols}) > (${sql.join(cur.after.map((v) => sql`${v}`), sql`, `)})` : sql``;
      const rows = await withTenantRead(ctx, async (tx) => (await tx.execute(sql`select * from ${sql.identifier(t.name)} ${after} order by ${cols} limit ${batch}`)).rows as Record<string, unknown>[]);
      if (rows.length) await write(`${t.name}.${cur.chunk}`, rows);
      const last = rows[rows.length - 1];
      cur = rows.length === batch && last ? { table: cur.table, after: t.pk.map((c) => last[c]), chunk: cur.chunk + 1 } : { table: cur.table + 1, after: null, chunk: 0 };
      await db.update(backupSnapshots).set({ cursor: cur, files, sizeBytes: size }).where(eq(backupSnapshots.id, s.id));
    }

    await db.update(backupSnapshots).set({ status: "completed", cursor: null, files, sizeBytes: size, finishedAt: new Date() }).where(eq(backupSnapshots.id, s.id));
    await withTenant(ctx, (tx) =>
      writeOutbox(tx, "backup.completed", s.id, { snapshotId: s.id, trigger: s.trigger, files: Object.keys(files).length, rows: Object.values(files).reduce((a, f) => a + f.rows, 0), sizeBytes: size }),
    );
    await prune(s.tenantId).catch((err) => log.warn("backup prune failed", { tenant: tenant.slug, err }));
    return "done";
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    log.error("backup failed", { tenant: tenant.slug, snapshot: s.id, err });
    await db.update(backupSnapshots).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(backupSnapshots.id, s.id));
    await alertFailure(s, ctx, message).catch(() => undefined);
    return "failed";
  } finally {
    await redis()
      .del(lock)
      .catch(() => undefined);
  }
}

async function alertFailure(s: Snapshot, ctx: Awaited<ReturnType<typeof contextForTenantId>>["ctx"], message: string) {
  const admins = await platformDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, s.tenantId), eq(users.role, "super_admin"), eq(users.status, "active")));
  await withTenant(ctx, async (tx) => {
    await writeOutbox(tx, "backup.failed", s.id, { snapshotId: s.id, trigger: s.trigger, error: message });
    await notify(
      tx,
      admins.map((a) => a.id),
      { kind: "system", title: "Nightly backup failed", body: `${message}. The next run retries; check Setup → Backups when it ships (T3.7).`, link: "/admin", dedupeKey: `backup-failed:${s.day ?? s.id}` },
    );
  });
}

/** Delete completed snapshots outside the policy, files first; failed ones after 7 days. */
async function prune(tenantId: string) {
  const db = platformDb();
  const [policy] = await db.select().from(backupPolicies).where(eq(backupPolicies.tenantId, tenantId));
  const done = await db
    .select({ id: backupSnapshots.id, day: backupSnapshots.day, startedAt: backupSnapshots.startedAt, files: backupSnapshots.files })
    .from(backupSnapshots)
    .where(and(eq(backupSnapshots.tenantId, tenantId), eq(backupSnapshots.status, "completed")));
  const drop = new Set(pruneList(done.map((d) => ({ id: d.id, day: d.day ?? d.startedAt.toISOString().slice(0, 10) })), policy ?? DEFAULT_POLICY));
  const doomed = done.filter((d) => drop.has(d.id));
  if (doomed.length) {
    await deleteBackupFiles(doomed.flatMap((d) => Object.values(d.files).map((f) => f.key)));
    await db.delete(backupSnapshots).where(inArray(backupSnapshots.id, doomed.map((d) => d.id)));
  }
  await db
    .delete(backupSnapshots)
    .where(and(eq(backupSnapshots.tenantId, tenantId), eq(backupSnapshots.status, "failed"), lt(backupSnapshots.startedAt, new Date(Date.now() - 7 * 86_400_000))));
}

/** Read back one table of a completed snapshot (restore T3.8, verification). */
export async function readSnapshotTable(snapshotId: string, table: string): Promise<Record<string, unknown>[]> {
  const [s] = await platformDb().select().from(backupSnapshots).where(eq(backupSnapshots.id, snapshotId));
  if (!s?.keyEnc) throw new Error("snapshot not found");
  const key = Buffer.from(decrypt(s.keyEnc), "base64");
  const parts = Object.entries(s.files)
    .filter(([name]) => name.startsWith(`${table}.`))
    .sort(([a], [b]) => Number(a.split(".").pop()) - Number(b.split(".").pop()));
  const out: Record<string, unknown>[] = [];
  for (const [, f] of parts) {
    const buf = await readBackupFile(f.key);
    if (sha256Hex(buf) !== f.sha256) throw new Error(`checksum mismatch in ${f.key}`);
    out.push(...openChunk(buf, key));
  }
  return out;
}
