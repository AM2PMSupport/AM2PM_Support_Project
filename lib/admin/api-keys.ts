/**
 * API keys — Setup → Developer (T2.5). Admins create a key for an
 * integration; it acts as the admin who created it, with "read" or "write"
 * scope. The key (am2pm_<random>) is shown ONCE; only its SHA-256 is stored.
 * Tenant-isolated by RLS; create/revoke are audited.
 */
import { desc, eq, isNull, and } from "drizzle-orm";
import { z } from "zod";
import { apiKeys, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { notFound } from "@/lib/http/errors";

export const API_KEY_PREFIX = "am2pm_";
export const ApiKeyInput = z.object({ name: z.string().trim().min(2).max(60), scope: z.enum(["read", "write"]).default("read") });

export async function createApiKey(ctx: SessionContext, raw: z.input<typeof ApiKeyInput>): Promise<{ id: string; key: string }> {
  requirePermission(ctx, "integrations", "C");
  const input = ApiKeyInput.parse(raw);
  const key = `${API_KEY_PREFIX}${randomToken(30)}`;
  const id = await withTenant(ctx, async (tx) => {
    const [k] = await tx
      .insert(apiKeys)
      .values({ userId: ctx.actor.userId, name: input.name, scope: input.scope, prefix: key.slice(0, 12), keyHash: sha256Hex(key) })
      .returning({ id: apiKeys.id });
    await writeAudit(tx, ctx, { action: "api_key.created", entity: "api_key", entityId: k!.id, after: { name: input.name, scope: input.scope } });
    return k!.id;
  });
  return { id, key };
}

export async function listApiKeys(ctx: SessionContext) {
  requirePermission(ctx, "integrations", "C");
  const rows = await withTenant(ctx, (tx) =>
    tx
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scope: apiKeys.scope, owner: users.name, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .orderBy(desc(apiKeys.createdAt)),
  );
  return rows.map((r) => ({ ...r, lastUsedAt: r.lastUsedAt?.toISOString() ?? null, revokedAt: r.revokedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
}

export async function revokeApiKey(ctx: SessionContext, id: string) {
  requirePermission(ctx, "integrations", "C");
  await withTenant(ctx, async (tx) => {
    const [k] = await tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id });
    if (!k) throw notFound("Key not found or already revoked");
    await writeAudit(tx, ctx, { action: "api_key.revoked", entity: "api_key", entityId: id });
  });
}
