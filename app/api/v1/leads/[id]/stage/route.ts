/** POST /api/v1/leads/{id}/stage — move to a stage of its process; the won stage converts (§3.13). */
import { badRequest, json, readJson } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { isUuid } from "@/lib/db/tenant";
import { StageInput, setStage } from "@/lib/agent/outcome";
import { getLeadDetail } from "@/lib/agent/queue";

export const POST = v1<{ id: string }>(
  async (req, ctx, p) => {
    if (!isUuid(p.id)) throw badRequest("Invalid lead id");
    const body = await readJson(req, StageInput.omit({ leadId: true }));
    await setStage(ctx, { ...body, leadId: p.id });
    return json(await getLeadDetail(ctx, p.id));
  },
  { write: true },
);
