/** POST /api/v1/leads/assign — reassign up to 200 leads to one agent (supervisors/admins) (§3.13). */
import { json, readJson } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { BulkAssignInput, bulkAssign } from "@/lib/leads/bulk";

export const POST = v1(async (req, ctx) => json(await bulkAssign(ctx, await readJson(req, BulkAssignInput))), { write: true });
