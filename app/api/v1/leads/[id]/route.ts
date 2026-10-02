/**
 * GET    /api/v1/leads/{id} — full lead: contact, stage, custom fields, outcomes, timeline (§3.12)
 * PATCH  /api/v1/leads/{id} — partial update; omitted fields stay (§3.12)
 * DELETE /api/v1/leads/{id} — move to the Recycle bin (leads D) (§3.12)
 */
import { badRequest, json, readJson } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { isUuid } from "@/lib/db/tenant";
import { getLeadDetail } from "@/lib/agent/queue";
import { EditLeadInput, deleteLeads, updateLead } from "@/lib/leads/edit";

const id = (p: { id: string }) => {
  if (!isUuid(p.id)) throw badRequest("Invalid lead id");
  return p.id;
};

export const GET = v1<{ id: string }>(async (_req, ctx, p) => json(await getLeadDetail(ctx, id(p))));

export const PATCH = v1<{ id: string }>(
  async (req, ctx, p) => {
    const leadId = id(p);
    const patch = await readJson(req, EditLeadInput.omit({ leadId: true }));
    await updateLead(ctx, { ...patch, leadId });
    return json(await getLeadDetail(ctx, leadId));
  },
  { write: true },
);

export const DELETE = v1<{ id: string }>(async (_req, ctx, p) => json(await deleteLeads(ctx, { leadIds: [id(p)] })), { write: true });
