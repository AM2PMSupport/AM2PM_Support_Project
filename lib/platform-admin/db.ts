/**
 * Platform (cross-tenant) database access — Super Admin tooling, tenant
 * lookup by slug, and the cron sweeps. Runs as the connection's own role
 * (the table owner), which row-level security does not restrict.
 *
 * This module and lib/db are the only places allowed to import the raw
 * client (eslint rule, RULE.md §1.4). Anything that changes one tenant's
 * business data should hand off to withTenant() instead.
 */
import { getDb, type Db } from "@/lib/db/client";

export function platformDb(): Db {
  return getDb();
}
