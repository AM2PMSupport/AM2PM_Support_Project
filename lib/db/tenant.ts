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
 */
import { sql } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import type { TenantContext } from "@/lib/tenancy/context";

export type { Tx };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export async function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(ctx.tenantId)) throw new Error("withTenant: invalid tenantId");
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
    await tx.execute(sql`set local role app_rls`);
    return fn(tx);
  });
}

/** Postgres unique-violation (dedupe, idempotency). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}
