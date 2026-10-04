/**
 * "Create Lead" on the Leads screen: the same path as every source —
 * normalise → dedupe insert (merge on conflict) → auto-assign — with source
 * kind "manual". Optionally assign straight to a chosen agent (needs the
 * leads "A" permission), otherwise the process's assignment rules decide.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { processes } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { canReassign, requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { normaliseLead } from "@/lib/leads/normalise";
import { createOrMergeLead } from "@/lib/leads/create";
import { bulkAssign } from "@/lib/leads/bulk";
import { badRequest, notFound } from "@/lib/http/errors";

export const ManualLeadInput = z.object({
  processId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(20).optional().default(""),
  /** Mobile 2 (optional second number). */
  altPhone: z.string().trim().max(20).optional().default(""),
  email: z.string().trim().max(254).optional().default(""),
  city: z.string().trim().max(60).optional().default(""),
  note: z.string().trim().max(500).optional().default(""),
  ownerId: z.uuid().optional(),
  /** API: campaign name and extra fields kept on the lead. */
  campaign: z.string().trim().max(120).optional(),
  custom: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean()])).optional().default({}),
});

export async function createManualLead(ctx: SessionContext, input: z.input<typeof ManualLeadInput>, sourceKind: "manual" | "api" = "manual") {
  input = ManualLeadInput.parse(input);
  requirePermission(ctx, "leads", "C");
  const [process] = await withTenant(ctx, (tx) =>
    tx.select({ id: processes.id, stages: processes.stages, dedupeField: processes.dedupeField }).from(processes).where(and(eq(processes.id, input.processId), eq(processes.status, "active"))),
  );
  if (!process) throw notFound("Process not found");
  const n = normaliseLead({ ...input.custom, name: input.name, phone: input.phone, altPhone: input.altPhone, email: input.email, ...(input.city ? { city: input.city } : {}), ...(input.note ? { note: input.note } : {}) });
  if (!n.ok) throw badRequest("Enter a valid 10-digit mobile number or an email");
  // Imports drop a bad Mobile 2 quietly; a person typing one should hear about it.
  if (input.altPhone && !n.lead.altPhoneKey) throw badRequest("Mobile 2 must be a different, valid 10-digit mobile number");
  const direct = !!input.ownerId && canReassign(ctx.actor);
  const res = await createOrMergeLead(ctx, process, n.lead, { kind: sourceKind, ...(input.campaign ? { campaign: input.campaign } : {}) }, { queueAssign: !direct });
  if (direct && res.outcome === "created") await bulkAssign(ctx, { leadIds: [res.leadId], ownerId: input.ownerId! });
  return res;
}
