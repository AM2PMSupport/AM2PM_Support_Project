/**
 * Lead layout storage (Setup → Lead layout, 2026-10-06). One row per
 * workspace in `field_layouts` (RLS); rules in lib/leads/layout.ts.
 *
 * Reading never needs config rights — every lead screen renders from the
 * layout — so `layoutIn(tx)` runs inside the caller's own transaction.
 * Saving / resetting needs config E and is audited. The custom-field list a
 * layout is checked against is the workspace's ACTIVE lead fields.
 */
import { and, asc, eq } from "drizzle-orm";
import { customFieldDefinitions, fieldLayouts, processes } from "@/lib/db/schema";
import { withTenant, withTenantRead, type Tx } from "@/lib/db/tenant";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { normalizeLayout, type Layout } from "@/lib/leads/layout";

async function activeKeys(tx: Tx): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ key: customFieldDefinitions.key, sort: customFieldDefinitions.sortOrder, label: customFieldDefinitions.label })
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.isActive, true), eq(customFieldDefinitions.entity, "lead")))
    .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.label));
  return [...new Set(rows.map((r) => r.key))];
}

/** The workspace's layout, normalised (default when none is saved). */
export async function layoutIn(tx: Tx): Promise<Layout> {
  const [row] = await tx.select({ layout: fieldLayouts.layout }).from(fieldLayouts).where(eq(fieldLayouts.entity, "lead"));
  return normalizeLayout(row?.layout ?? null, await activeKeys(tx));
}

/** Setup → Lead layout: the layout plus every custom field (with its process) and the processes. */
export async function getLayoutEditor(ctx: SessionContext) {
  requirePermission(ctx, "config", "V");
  return withTenantRead(ctx, async (tx) => {
    const [layout, fields, procs, [row]] = await Promise.all([
      layoutIn(tx),
      tx
        .select({ id: customFieldDefinitions.id, key: customFieldDefinitions.key, label: customFieldDefinitions.label, type: customFieldDefinitions.type, options: customFieldDefinitions.options, required: customFieldDefinitions.required, processId: customFieldDefinitions.processId })
        .from(customFieldDefinitions)
        .where(and(eq(customFieldDefinitions.isActive, true), eq(customFieldDefinitions.entity, "lead")))
        .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.label)),
      tx.select({ id: processes.id, name: processes.name }).from(processes).where(eq(processes.status, "active")).orderBy(processes.name),
      tx.select({ updatedAt: fieldLayouts.updatedAt }).from(fieldLayouts).where(eq(fieldLayouts.entity, "lead")),
    ]);
    return { layout, fields, processes: procs, customised: !!row };
  });
}

export async function saveLayout(ctx: SessionContext, raw: unknown): Promise<Layout> {
  requirePermission(ctx, "config", "E");
  return withTenant(ctx, async (tx) => {
    const layout = normalizeLayout(raw, await activeKeys(tx));
    await tx
      .insert(fieldLayouts)
      .values({ entity: "lead", layout, updatedBy: ctx.actor.userId })
      .onConflictDoUpdate({ target: [fieldLayouts.tenantId, fieldLayouts.entity], set: { layout, updatedBy: ctx.actor.userId, updatedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "lead_layout.saved", entity: "layout", after: { sections: layout.sections.map((s) => `${s.title} (${s.fields.length})`), hidden: layout.hidden, labels: layout.labels } });
    return layout;
  });
}

export async function resetLayout(ctx: SessionContext): Promise<void> {
  requirePermission(ctx, "config", "E");
  await withTenant(ctx, async (tx) => {
    await tx.delete(fieldLayouts).where(eq(fieldLayouts.entity, "lead"));
    await writeAudit(tx, ctx, { action: "lead_layout.reset", entity: "layout" });
  });
}
