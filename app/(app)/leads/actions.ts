"use server";

/**
 * Server actions for the Leads screen: saved filters, bulk reassign / stage,
 * Create Lead. Each: signed-in session → Zod → lib function (permission +
 * RLS + audit) → revalidate. Errors come back as plain, user-safe messages.
 */
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { getSession, type SessionContext } from "@/lib/auth/session";
import { ApiError } from "@/lib/http/errors";
import { log } from "@/lib/log";
import { ViewInput, deleteView, saveView } from "@/lib/leads/views";
import { BulkAssignInput, BulkStageInput, bulkAssign, bulkStage } from "@/lib/leads/bulk";
import { ManualLeadInput, createManualLead } from "@/lib/leads/manual";
import { EditLeadInput, LeadIdsInput, deleteLeads, restoreLeads, updateLead } from "@/lib/leads/edit";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

async function run<T>(fn: (ctx: SessionContext) => Promise<T>): Promise<ActionResult<T>> {
  const ctx = await getSession();
  if (!ctx) return { ok: false, error: "Your session has ended. Sign in again." };
  try {
    const data = await fn(ctx);
    revalidatePath("/leads");
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return { ok: false, error: `${i?.path.join(".") || "Input"}: ${i?.message ?? "invalid"}` };
    }
    log.error("leads action failed", { err });
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

export async function saveViewAction(input: z.input<typeof ViewInput>) {
  return run((ctx) => saveView(ctx, ViewInput.parse(input)));
}
export async function deleteViewAction(id: string) {
  return run((ctx) => deleteView(ctx, z.uuid().parse(id)));
}
export async function bulkAssignAction(input: z.input<typeof BulkAssignInput>) {
  return run((ctx) => bulkAssign(ctx, BulkAssignInput.parse(input)));
}
export async function bulkStageAction(input: z.input<typeof BulkStageInput>) {
  return run((ctx) => bulkStage(ctx, BulkStageInput.parse(input)));
}
export async function createLeadAction(input: z.input<typeof ManualLeadInput>) {
  return run((ctx) => createManualLead(ctx, ManualLeadInput.parse(input)));
}

// ── Row actions: edit, delete (Recycle bin), restore ─────────────────────────
export async function updateLeadAction(input: z.input<typeof EditLeadInput>) {
  return run((ctx) => updateLead(ctx, input));
}
export async function deleteLeadsAction(input: z.input<typeof LeadIdsInput>) {
  return run((ctx) => deleteLeads(ctx, LeadIdsInput.parse(input)));
}
export async function restoreLeadsAction(input: z.input<typeof LeadIdsInput>) {
  return run((ctx) => restoreLeads(ctx, LeadIdsInput.parse(input)));
}
