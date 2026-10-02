/**
 * API key lookup (before the tenant is known → owner connection, like
 * sign-in). Returns the key's user + workspace only when the key is not
 * revoked, the user is active and the workspace is active/trial.
 */
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { apiKeys, tenants, users, type Role } from "@/lib/db/schema";
import { platformDb } from "@/lib/platform-admin/db";
import { sha256Hex } from "@/lib/crypto";

export interface ApiKeyIdentity {
  keyId: string;
  scope: "read" | "write";
  userId: string;
  role: Role;
  name: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  timezone: string;
}

export async function lookupApiKey(rawKey: string): Promise<ApiKeyIdentity | null> {
  const [r] = await platformDb()
    .select({
      keyId: apiKeys.id,
      scope: apiKeys.scope,
      userId: users.id,
      role: users.role,
      name: users.name,
      tenantId: tenants.id,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      timezone: tenants.timezone,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
    .where(and(eq(apiKeys.keyHash, sha256Hex(rawKey)), isNull(apiKeys.revokedAt), eq(users.status, "active"), inArray(tenants.status, ["active", "trial"])));
  if (!r) return null;
  // Record use at most every 5 minutes (a busy integration shouldn't write on every call).
  await platformDb()
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.id, r.keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, sql`now() - interval '5 minutes'`))));
  return r;
}
