/** POST /api/v1/leads/{id}/restore — bring a lead back from the Recycle bin (leads D) (§3.12). */
import { badRequest, json } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { isUuid } from "@/lib/db/tenant";
import { restoreLeads } from "@/lib/leads/edit";

export const POST = v1<{ id: string }>(
  async (_req, ctx, p) => {
    if (!isUuid(p.id)) throw badRequest("Invalid lead id");
    return json(await restoreLeads(ctx, { leadIds: [p.id] }));
  },
  { write: true },
);
