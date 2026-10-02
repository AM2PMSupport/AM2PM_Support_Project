/**
 * In-app notifications (callback due, missed callback, re-enquiry, SLA).
 * `dedupeKey` makes a reminder idempotent: the same key is inserted once,
 * so cron/QStash retries never double-notify.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { notifications, userProcesses, users } from "@/lib/db/schema";
import { withTenant, type Tx } from "@/lib/db/tenant";
import type { SessionContext } from "@/lib/auth/session";

type Kind = (typeof notifications.$inferInsert)["kind"];

export async function notify(
  tx: Tx,
  userIds: string[],
  n: { kind: Kind; title: string; body?: string; link?: string; dedupeKey?: string },
): Promise<void> {
  if (!userIds.length) return;
  await tx
    .insert(notifications)
    .values(userIds.map((userId) => ({ userId, ...n, dedupeKey: n.dedupeKey ? `${n.dedupeKey}:${userId}` : null })))
    .onConflictDoNothing();
}

/** Supervisors and managers mapped to a process (escalation targets). */
export async function supervisorsOf(tx: Tx, processId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(userProcesses, eq(userProcesses.userId, users.id))
    .where(and(eq(userProcesses.processId, processId), inArray(users.role, ["project_supervisor", "manager"]), eq(users.status, "active")));
  return rows.map((r) => r.id);
}

export async function myNotifications(ctx: SessionContext, limit = 20) {
  return withTenant(ctx, async (tx) => {
    const items = await tx
      .select()
      .from(notifications)
      .where(eq(notifications.userId, ctx.actor.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    const [unread] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, ctx.actor.userId), isNull(notifications.readAt)));
    return { unread: unread?.n ?? 0, items: items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString(), readAt: i.readAt?.toISOString() ?? null })) };
  });
}

export async function markAllRead(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, ctx.actor.userId), isNull(notifications.readAt))),
  );
}
