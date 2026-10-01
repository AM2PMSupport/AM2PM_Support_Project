/**
 * Integration-test database: real Postgres running in-process (PGlite).
 *
 * Applies the SAME migrations as production (drizzle/), including the
 * row-level-security policies, and plugs the instance into lib/db/client via
 * setDbForTests(). withTenant() then runs as the restricted app_rls role, so
 * tests exercise the real isolation rules — not a mock.
 */
import { PGlite } from "@electric-sql/pglite";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { setDbForTests, type Db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import type { TenantContext } from "@/lib/tenancy/context";

export async function createTestDb() {
  // Same extensions as production (drizzle/0002_search_extensions.sql).
  const client = new PGlite({ extensions: { pg_trgm, btree_gin } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  // PGlite and node-postgres drizzle instances share the same query API.
  setDbForTests(db as unknown as Db);
  return {
    /** Owner connection: bypasses RLS, like lib/platform-admin. Use for seeding. */
    db,
    close: async () => {
      setDbForTests(undefined);
      await client.close();
    },
  };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

export async function seedTenant(db: TestDb, slug: string): Promise<TenantContext> {
  const [t] = await db.insert(schema.tenants).values({ name: slug, slug, timezone: "Asia/Kolkata" }).returning();
  return { tenantId: t!.id, tenantSlug: t!.slug, timezone: t!.timezone };
}

/** In-memory stand-in for the Upstash Redis client (only what the app uses). */
export function fakeRedis() {
  const store = new Map<string, unknown>();
  return {
    store,
    async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
  };
}
