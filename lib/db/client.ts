/**
 * One Postgres pool per function instance (RULE.md §2.12).
 *
 * Connects to Neon's POOLED connection string (`DATABASE_URL`, PgBouncer in
 * transaction mode). That is safe for us because all tenant settings are
 * transaction-scoped (`set_config(..., true)`, `SET LOCAL ROLE`), never
 * session-scoped. The pool is kept small (10) and registered with
 * `attachDatabasePool` so Vercel Fluid compute can close idle connections
 * before an instance is suspended.
 *
 * Only lib/db and lib/platform-admin may import this module (eslint rule);
 * tenant code uses withTenant() from lib/db/tenant.ts, which enforces
 * row-level security.
 */
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { attachDatabasePool } from "@vercel/functions";
import { databaseEnv } from "@/lib/config/env";
import * as schema from "@/lib/db/schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle; same query API as Db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __am2pmDb?: Db };

function connect(): Db {
  const pool = new Pool({
    connectionString: databaseEnv().DATABASE_URL,
    max: 10,
    // Fail fast in serverless rather than hanging a request.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  attachDatabasePool(pool);
  return drizzle(pool, { schema });
}

export function getDb(): Db {
  return (globalForDb.__am2pmDb ??= connect());
}

/**
 * Tests only: run the app against an in-process Postgres (PGlite).
 * The query API is identical; see tests/helpers/db.ts.
 */
export function setDbForTests(db: Db | undefined): void {
  globalForDb.__am2pmDb = db;
}
