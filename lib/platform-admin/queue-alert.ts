/**
 * Tells every Super Admin (in each workspace where they have the role) that
 * the background queue is refusing messages. Cross-workspace lookup, so it
 * lives in platform-admin; the notification itself is written per workspace
 * under RLS. Deduped per day. See lib/queue/health.ts.
 */
import { and, eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { notify } from "@/lib/notifications";
import { platformDb } from "@/lib/platform-admin/db";
import { contextForTenantId } from "@/lib/platform-admin/tenants";
import type { QueueState } from "@/lib/queue/health";
import { log } from "@/lib/log";

export async function alertSuperAdmins(state: QueueState): Promise<void> {
  const rows = await platformDb()
    .select({ id: users.id, tenantId: users.tenantId })
    .from(users)
    .where(and(eq(users.role, "super_admin"), eq(users.status, "active")));
  const byTenant = new Map<string, string[]>();
  for (const r of rows) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r.id]);
  const day = state.since.slice(0, 10);
  for (const [tenantId, ids] of byTenant) {
    try {
      const { ctx } = await contextForTenantId(tenantId);
      await withTenant(ctx, (tx) =>
        notify(tx, ids, {
          kind: "system",
          title: "Background queue is refusing messages",
          body: `${state.reason}. Calls and leads are still saved and processed by the backup path, but more slowly. Check the QStash plan / billing in Upstash.`,
          link: "/admin",
          dedupeKey: `queue-degraded:${day}`,
        }),
      );
    } catch (err) {
      log.error("queue alert failed for a workspace", { tenantId, err });
    }
  }
}
