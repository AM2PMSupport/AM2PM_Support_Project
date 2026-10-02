/** GET /api/v1/calls — call log in scope with result, durations, recording flag (§3.14). */
import { json } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { CallQuery, listCalls } from "@/lib/calls/list";

export const GET = v1(async (req, ctx) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  CallQuery.parse(params); // 400 invalid_input on bad params
  return json(await listCalls(ctx, params));
});
