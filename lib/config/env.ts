/**
 * Typed, validated environment variables.
 *
 * Each group is parsed lazily the first time it is used, so a route that only
 * needs MongoDB does not fail because Redis variables are missing (useful in
 * tests and during incremental setup). Missing or malformed values throw a
 * clear error naming the variable instead of failing deep inside an SDK.
 */
import { z } from "zod";

function lazy<T>(parse: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= parse());
}

function parse<S extends z.ZodType>(schema: S, group: string): z.infer<S> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const names = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid env for ${group}: ${names}. See .env.example.`);
  }
  return result.data;
}

export const appEnv = lazy(() =>
  parse(z.object({ APP_URL: z.url() }), "app"),
);

export const databaseEnv = lazy(() =>
  parse(
    z.object({
      // Neon POOLED connection string (runtime). Migrations use DATABASE_URL_UNPOOLED.
      DATABASE_URL: z.string().startsWith("postgres"),
    }),
    "Postgres",
  ),
);

export const qstashEnv = lazy(() =>
  parse(
    z.object({
      QSTASH_TOKEN: z.string().min(1),
      QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
      QSTASH_NEXT_SIGNING_KEY: z.string().min(1),
    }),
    "QStash",
  ),
);

export const redisEnv = lazy(() =>
  parse(
    z.object({
      UPSTASH_REDIS_REST_URL: z.url(),
      UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
    }),
    "Redis",
  ),
);

export const securityEnv = lazy(() =>
  parse(
    z.object({
      // 32 bytes, base64-encoded. Used for AES-256-GCM (lib/crypto).
      MASTER_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
        message: "must be 32 bytes, base64",
      }),
      CRON_SECRET: z.string().min(16),
    }),
    "security",
  ),
);
