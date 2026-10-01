/**
 * Postgres connections: one PRIMARY pool for all writes, plus optional READ
 * REPLICA pools for read-only work (RULE.md §2.13, ARCHITECTURE.md §10).
 *
 * Primary — Neon's POOLED connection string (`DATABASE_URL`, PgBouncer in
 * transaction mode). Safe because tenant settings are transaction-scoped
 * (`set_config(..., true)`, `SET LOCAL ROLE`), never session-scoped.
 *
 * Replicas — `DATABASE_REPLICA_URLS` (comma-separated). Neon read replicas
 * share the primary's storage, so RLS policies and roles are identical.
 * `getReadTarget()` returns the replica with the LEAST active connections
 * (lib/db/least-connections.ts). A replica that fails to connect is taken
 * out of rotation for 30 s (circuit breaker) and reads fall back to the
 * primary — a replica outage never takes reads down.
 *
 * Each pool is small (max 10) and registered with `attachDatabasePool` so
 * Vercel Fluid compute can close idle connections before suspending.
 *
 * Only lib/db and lib/platform-admin may import this module (eslint rule).
 */
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { attachDatabasePool } from "@vercel/functions";
import { databaseEnv } from "@/lib/config/env";
import { pickLeastConnections } from "@/lib/db/least-connections";
import * as schema from "@/lib/db/schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle; same query API as Db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** How long a failing replica stays out of rotation. */
const CIRCUIT_OPEN_MS = 30_000;

export interface ReadTarget {
  db: Db;
  /** "primary" or "replica-<n>", for logs only (never the URL). */
  name: string;
  /** Current load: connections in use + requests waiting. */
  load: () => { active: number; waiting: number };
  unhealthyUntil: number;
  lastPicked: number;
}

const globalForDb = globalThis as unknown as {
  __am2pmDb?: Db;
  __am2pmPrimaryLoad?: () => { active: number; waiting: number };
  __am2pmReplicas?: ReadTarget[];
  __am2pmPickSeq?: number;
};

function makePool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    // Fail fast in serverless rather than hanging a request.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  attachDatabasePool(pool);
  return pool;
}

function poolLoad(pool: Pool) {
  return () => ({ active: pool.totalCount - pool.idleCount, waiting: pool.waitingCount });
}

/** Primary database: every write and every read-then-write goes here. */
export function getDb(): Db {
  if (!globalForDb.__am2pmDb) {
    const pool = makePool(databaseEnv().DATABASE_URL);
    globalForDb.__am2pmDb = drizzle(pool, { schema });
    globalForDb.__am2pmPrimaryLoad = poolLoad(pool);
  }
  return globalForDb.__am2pmDb;
}

function replicas(): ReadTarget[] {
  if (!globalForDb.__am2pmReplicas) {
    globalForDb.__am2pmReplicas = databaseEnv().DATABASE_REPLICA_URLS.map((url, i) => {
      const pool = makePool(url);
      return { db: drizzle(pool, { schema }), name: `replica-${i + 1}`, load: poolLoad(pool), unhealthyUntil: 0, lastPicked: 0 };
    });
  }
  return globalForDb.__am2pmReplicas;
}

/**
 * Least-connections pick among healthy replicas; the primary when there are
 * no replicas or none is healthy.
 */
export function getReadTarget(now = Date.now()): ReadTarget {
  const list = replicas();
  const idx = pickLeastConnections(
    list.map((r) => ({ ...r.load(), healthy: r.unhealthyUntil <= now, lastPicked: r.lastPicked })),
  );
  if (idx === -1) {
    return { db: getDb(), name: "primary", load: globalForDb.__am2pmPrimaryLoad ?? (() => ({ active: 0, waiting: 0 })), unhealthyUntil: 0, lastPicked: 0 };
  }
  const chosen = list[idx]!;
  chosen.lastPicked = globalForDb.__am2pmPickSeq = (globalForDb.__am2pmPickSeq ?? 0) + 1;
  return chosen;
}

/** Open the circuit for a replica after a connection-level failure. */
export function markReplicaDown(target: ReadTarget, now = Date.now()): void {
  if (target.name !== "primary") target.unhealthyUntil = now + CIRCUIT_OPEN_MS;
}

/** Replica health summary for /api/health (names and states only). */
export function replicaStatus(now = Date.now()): { name: string; healthy: boolean }[] {
  return replicas().map((r) => ({ name: r.name, healthy: r.unhealthyUntil <= now }));
}

/** Connection-level errors (not SQL errors) — the ones worth failing over on. */
export function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const code = e?.code ?? e?.cause?.code ?? "";
  const msg = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
  return (
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "57P01", "57P03", "08000", "08001", "08003", "08006"].includes(code) ||
    /Connection terminated|timeout exceeded when trying to connect/i.test(msg)
  );
}

// ------------------------------------------------------------------ tests

/**
 * Tests only: run the app against an in-process Postgres (PGlite).
 * The query API is identical; see tests/helpers/db.ts.
 */
export function setDbForTests(db: Db | undefined): void {
  globalForDb.__am2pmDb = db;
  globalForDb.__am2pmPrimaryLoad = undefined;
  // No replicas by default in tests; setReplicasForTests() adds fakes.
  globalForDb.__am2pmReplicas = db ? [] : undefined;
}

/** Tests only: install fake replica targets. */
export function setReplicasForTests(targets: ReadTarget[] | undefined): void {
  globalForDb.__am2pmReplicas = targets;
}
