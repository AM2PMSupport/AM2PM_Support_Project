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

function parse<S extends z.ZodType>(schema: S, group: string, source: Record<string, unknown> = process.env): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const names = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid env for ${group}: ${names}. See .env.example.`);
  }
  return result.data;
}

export const appEnv = lazy(() =>
  parse(
    z.object({
      APP_URL: z.url(),
      // Public HTTPS address that OUTSIDE services call (CallerDesk, lead
      // sources). Never localhost: a provider can't reach a laptop. Falls back
      // to APP_URL when unset (production, where APP_URL is already public).
      PUBLIC_URL: z.url().optional(),
    }),
    "app",
  ),
);

/** Base URL for webhook URLs handed to providers (see PUBLIC_URL). */
export function publicBaseUrl(): string {
  const env = appEnv();
  return (env.PUBLIC_URL ?? env.APP_URL).replace(/\/+$/, "");
}

/** True when a URL is only reachable from this machine. */
export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.local)(:|\/|$)/i.test(url);
}

export const databaseEnv = lazy(() =>
  parse(
    z.object({
      // Neon POOLED connection string (runtime). Migrations use DATABASE_URL_UNPOOLED.
      DATABASE_URL: z.string().startsWith("postgres"),
      // Optional Neon read replicas (comma-separated pooled URLs). Reads made
      // with withTenantRead() go to the replica with the fewest active
      // connections; empty = all reads use the primary.
      DATABASE_REPLICA_URLS: z
        .string()
        .optional()
        .transform((v) => (v ?? "").split(",").map((u) => u.trim()).filter((u) => u.startsWith("postgres"))),
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

export const redisEnv = lazy(() => {
  // The Vercel Marketplace Upstash integration injects KV_REST_API_*;
  // a directly-created Upstash database uses UPSTASH_REDIS_REST_*. Accept both.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return parse(
    z.object({ UPSTASH_REDIS_REST_URL: z.url(), UPSTASH_REDIS_REST_TOKEN: z.string().min(1) }),
    "Redis",
    { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token },
  );
});

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

export const authEnv = lazy(() =>
  parse(
    z.object({
      // Signs session cookies (lib/auth/token.ts). Different per environment.
      AUTH_SECRET: z.string().min(32),
    }),
    "auth",
  ),
);
