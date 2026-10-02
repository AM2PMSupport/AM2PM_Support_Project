/**
 * "Remove sample data" (Setup → Data administration): deletes ONLY the demo
 * process created by `npm run seed:demo` — matched by its exact name — with
 * its leads, contacts, calls, callbacks and outcomes. Real processes are
 * never touched. Same order as scripts/seed-demo.ts --remove, but inside
 * withTenant (RLS-bound) and audited.
 */
import { and, eq, inArray } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";

export const SAMPLE_PROCESS_NAME = "Demo · Sales (sample leads)";

export async function sampleDataSummary(ctx: SessionContext) {
  requirePermission(ctx, "config", "V");
  return withTenant(ctx, async (tx) => {
    const [p] = await tx.select({ id: s.processes.id }).from(s.processes).where(eq(s.processes.name, SAMPLE_PROCESS_NAME));
    if (!p) return null;
    const leads = await tx.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.processId, p.id));
    return { leads: leads.length };
  });
}

export async function removeSampleData(ctx: SessionContext) {
  requirePermission(ctx, "config", "E");
  return withTenant(ctx, async (tx) => {
    const [p] = await tx.select({ id: s.processes.id }).from(s.processes).where(eq(s.processes.name, SAMPLE_PROCESS_NAME));
    if (!p) return { removed: 0 };
    const rows = await tx.select({ id: s.leads.id, contactId: s.leads.contactId, owner: s.leads.assignedTo, status: s.leads.status }).from(s.leads).where(eq(s.leads.processId, p.id));
    const leadIds = rows.map((r) => r.id);
    if (leadIds.length) {
      await tx.delete(s.callbacks).where(inArray(s.callbacks.leadId, leadIds));
      await tx.delete(s.leadEvents).where(inArray(s.leadEvents.leadId, leadIds));
      await tx.delete(s.interactions).where(inArray(s.interactions.leadId, leadIds));
      await tx.delete(s.leads).where(inArray(s.leads.id, leadIds));
      // Contacts only if no other (real) lead uses them.
      for (const c of [...new Set(rows.map((r) => r.contactId))]) {
        const [still] = await tx.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.contactId, c)).limit(1);
        if (!still) await tx.delete(s.contacts).where(eq(s.contacts.id, c));
      }
      // Give the owners their capacity back.
      const open = new Map<string, number>();
      for (const r of rows) if (r.owner && r.status === "open") open.set(r.owner, (open.get(r.owner) ?? 0) + 1);
      for (const [uid, n] of open) {
        const [u] = await tx.select({ n: s.users.openLeads }).from(s.users).where(eq(s.users.id, uid));
        await tx.update(s.users).set({ openLeads: Math.max((u?.n ?? 0) - n, 0) }).where(eq(s.users.id, uid));
      }
    }
    // Tables whose process FK doesn't cascade.
    await tx.delete(s.importBatches).where(eq(s.importBatches.processId, p.id));
    await tx.delete(s.importSources).where(eq(s.importSources.processId, p.id));
    await tx.delete(s.telephonyDids).where(eq(s.telephonyDids.processId, p.id));
    await tx.delete(s.dispositions).where(eq(s.dispositions.processId, p.id));
    await tx.delete(s.userProcesses).where(eq(s.userProcesses.processId, p.id));
    await tx.delete(s.assignmentState).where(eq(s.assignmentState.processId, p.id));
    await tx.delete(s.processes).where(and(eq(s.processes.id, p.id), eq(s.processes.name, SAMPLE_PROCESS_NAME)));
    await writeAudit(tx, ctx, { action: "sample_data.removed", entity: "process", entityId: p.id, after: { leads: leadIds.length } });
    return { removed: leadIds.length };
  });
}
