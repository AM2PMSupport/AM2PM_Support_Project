/**
 * Lead visibility inside a tenant (DESIGN.md §7), as a SQL condition.
 *
 *   own     → leads.assigned_to = me
 *   process → leads.process_id in my user_processes
 *   tenant  → no extra condition (RLS already limits to the tenant)
 *   none    → nothing
 *
 * Use it in every lead query: `.where(and(leadScopeCondition(ctx), …))`.
 */
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { leads, userProcesses } from "@/lib/db/schema";
import { leadScope } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";

export function leadScopeCondition(ctx: SessionContext): SQL | undefined {
  switch (leadScope(ctx.actor.role)) {
    case "tenant":
      return undefined;
    case "own":
      return eq(leads.assignedTo, ctx.actor.userId);
    case "process":
      return inArray(
        leads.processId,
        sql`(select ${userProcesses.processId} from ${userProcesses} where ${userProcesses.userId} = ${ctx.actor.userId})`,
      );
    case "none":
      return sql`false`;
  }
}
