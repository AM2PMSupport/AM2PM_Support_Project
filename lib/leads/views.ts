/**
 * Saved filters on the Leads screen ("Meta leads", "My overdue callbacks").
 * A view stores the screen's URL params; it is personal unless `shared`,
 * which makes it visible to everyone in the workspace (only roles that may
 * configure the workspace can share). Tenant-isolated by RLS.
 */
import { and, asc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { savedViews } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { can } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { LeadQuery } from "@/lib/leads/list";
import { forbidden, notFound } from "@/lib/http/errors";

export const ViewInput = z.object({
  name: z.string().trim().min(1).max(40),
  query: z.record(z.string(), z.string().max(2000)),
  shared: z.boolean().default(false),
});

export async function listViews(ctx: SessionContext) {
  const rows = await withTenant(ctx, (tx) =>
    tx
      .select({ id: savedViews.id, name: savedViews.name, query: savedViews.query, shared: savedViews.shared, userId: savedViews.userId })
      .from(savedViews)
      .where(and(eq(savedViews.module, "leads"), or(eq(savedViews.userId, ctx.actor.userId), eq(savedViews.shared, true))))
      .orderBy(asc(savedViews.name)),
  );
  return rows.map(({ userId, ...v }) => ({ ...v, mine: userId === ctx.actor.userId }));
}

export async function saveView(ctx: SessionContext, input: z.infer<typeof ViewInput>) {
  if (input.shared && !can(ctx.actor, "config", "E")) throw forbidden("Only admins can share a filter with everyone");
  // Keep only params the Leads screen understands; never paging state.
  const known = Object.keys(LeadQuery.shape).filter((k) => k !== "cursor");
  const query = Object.fromEntries(Object.entries(input.query).filter(([k, v]) => (known.includes(k) || /^cf_[a-z0-9_]{1,40}$/.test(k)) && v));
  LeadQuery.parse(query);
  const [v] = await withTenant(ctx, (tx) => tx.insert(savedViews).values({ userId: ctx.actor.userId, name: input.name, query, shared: input.shared }).returning({ id: savedViews.id }));
  return { id: v!.id };
}

export async function deleteView(ctx: SessionContext, id: string) {
  await withTenant(ctx, async (tx) => {
    const [v] = await tx.select({ userId: savedViews.userId, shared: savedViews.shared }).from(savedViews).where(eq(savedViews.id, id));
    if (!v) throw notFound("Filter not found");
    if (v.userId !== ctx.actor.userId && !(v.shared && can(ctx.actor, "config", "E"))) throw forbidden("You can only delete your own filters");
    await tx.delete(savedViews).where(eq(savedViews.id, id));
  });
}
