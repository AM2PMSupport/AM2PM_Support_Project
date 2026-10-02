/**
 * Audit trail writer (SECURITY.md §2). Append-only: app_rls can INSERT and
 * SELECT audit_logs but never UPDATE or DELETE (drizzle/0001_rls.sql).
 *
 * Call inside the same transaction as the change, so the log and the change
 * commit together. Never put secrets or full phone numbers in before/after.
 */
import { auditLogs } from "@/lib/db/schema";
import type { Tx } from "@/lib/db/tenant";
import type { TenantContext } from "@/lib/tenancy/context";

export async function writeAudit(
  tx: Tx,
  ctx: TenantContext,
  entry: { action: string; entity: string; entityId?: string | null; before?: unknown; after?: unknown },
): Promise<void> {
  await tx.insert(auditLogs).values({
    actorId: ctx.actor?.userId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
