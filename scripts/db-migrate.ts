/**
 * `npm run db:migrate` — apply SQL migrations in drizzle/ (idempotent).
 *
 * 0000_init.sql  tables, foreign keys, indexes (generated from lib/db/schema.ts)
 * 0001_rls.sql   app_rls role + row-level security policies (hand-written)
 *
 * Uses the UNPOOLED Neon URL: DDL should not go through PgBouncer.
 * Workflow: edit lib/db/schema.ts → `npm run db:generate` → review the new
 * SQL file → commit → `npm run db:migrate` (Vercel build step in CI later).
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL_UNPOOLED (or DATABASE_URL) in .env.local");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.log("✓ migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
