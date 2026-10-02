/**
 * GET  /api/v1/leads — list/filter/search leads in scope (API.md §3.7).
 * POST /api/v1/leads — create a lead; dedupes like every source (merges into
 *      the open lead with the same number/email) and auto-assigns (§3.11).
 */
import { json, readJson } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { LeadQuery, listLeads } from "@/lib/leads/list";
import { ManualLeadInput, createManualLead } from "@/lib/leads/manual";

export const GET = v1(async (req, ctx) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  LeadQuery.parse(params); // 400 invalid_input on bad params (listLeads parses again)
  return json(await listLeads(ctx, params));
});

export const POST = v1(
  async (req, ctx) => {
    const input = await readJson(req, ManualLeadInput);
    const r = await createManualLead(ctx, input, ctx.via === "api_key" ? "api" : "manual");
    return json(r, r.outcome === "created" ? 201 : 200);
  },
  { write: true },
);
