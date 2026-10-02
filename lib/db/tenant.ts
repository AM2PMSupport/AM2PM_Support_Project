/**
 * withTenant(): the ONLY way application code touches tenant data.
 *
 * Every call runs `fn` in one Postgres transaction that first does:
 *
 *   select set_config('app.tenant_id', <tenant uuid>, true);  -- transaction-local
 *   set local role app_rls;                                    -- restricted role
 *
 * `app_rls` has no BYPASSRLS and owns nothing, so the row-level security
 * policies in drizzle/0001_rls.sql apply to every statement: rows of other
 * tenants are invisible, and inserting/updating a row for another tenant
 * fails. `tenant_id` columns default to the setting, so inserts need not
 * pass it. Isolation is enforced by the DATABASE, not by remembering a
 * WHERE clause (RULE.md §1).
 *
 * Keep transactions short: no HTTP calls to providers inside `fn`.
 * Pure reads can use withTenantRead() below (read replicas, least connections).
 */
import { sql } from "drizzle-orm";
import { getDb, getReadTarget, isConnectionError, markReplicaDown, type Db, type Tx } from "@/lib/db/client";
import { log } from "@/lib/log";
import type { TenantContext } from "@/lib/tenancy/context";

export type { Tx };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export async function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runAsTenant(getDb(), ctx, fn, "read write");
}

/**
 * Read-only variant for pure reads — lists, dashboards, reports, exports.
 * Runs on the read replica with the LEAST active connections; if that
 * replica cannot be reached it is taken out of rotation for 30 s and the
 * read is retried once on the primary. Same RLS rules apply (replicas share
 * the primary's storage, roles and policies).
 *
 * Never use it for a read that decides a write (replicas lag slightly):
 * do those inside withTenant() on the primary.
 */
export async function withTenantRead<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const target = getReadTarget();
  if (target.name === "primary") return runAsTenant(target.db, ctx, fn, "read only");
  try {
    return await runAsTenant(target.db, ctx, fn, "read only");
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    markReplicaDown(target);
    log.warn("read replica unreachable; failing over to primary", { replica: target.name });
    return runAsTenant(getDb(), ctx, fn, "read only");
  }
}

async function runAsTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Tx) => Promise<T>, accessMode: "read only" | "read write"): Promise<T> {
  if (!isUuid(ctx.tenantId)) throw new Error("withTenant: invalid tenantId");
  return db.transaction(
    async (tx) => {
      // ONE round trip for both: set_config('role', …, true) is exactly
      // `SET LOCAL ROLE`. Every round trip counts (~100 ms from a laptop to
      // Neon Singapore), and this runs at the start of every transaction.
      // tenant_id is set first, then the role switch.
      await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('role', 'app_rls', true)`);
      return fn(tx);
    },
    { accessMode },
  );
}

/** Postgres unique-violation (dedupe, idempotency). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}
