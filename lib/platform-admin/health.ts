/**
 * Dependency health checks for GET /api/health. Lives in platform-admin
 * because it touches the database outside any tenant (a bare `select 1`).
 */
import { sql } from "drizzle-orm";
import { replicaStatus } from "@/lib/db/client";
import { platformDb } from "@/lib/platform-admin/db";
import { redis } from "@/lib/redis/client";

export const pingDatabase = () => platformDb().execute(sql`select 1`);
export const pingRedis = () => redis().ping();

/** Read replicas in rotation (names + circuit state only). */
export const replicas = () => replicaStatus();
