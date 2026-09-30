/**
 * drizzle-kit config. `npm run db:generate` writes SQL migrations to
 * drizzle/ from lib/db/schema.ts; `npm run db:migrate` applies them.
 * Migrations use the UNPOOLED (direct) Neon URL because DDL should not go
 * through PgBouncer.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "" },
  strict: true,
});
