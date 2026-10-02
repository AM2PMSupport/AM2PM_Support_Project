/**
 * POST /api/v1/leads/{id}/call — the agent's Call button.
 *
 * Starts an API click-to-call: the provider rings the agent's own phone,
 * then the customer (lib/telephony/click-to-call.ts). Returns immediately
 * with the interaction id; live status arrives over SSE from webhooks.
 *
 * 409 already_on_call · 403 dnc / not your lead · 422 setup missing ·
 * 502 provider rejected (message is safe to show the agent).
 */
import { isUuid } from "@/lib/db/tenant";
import { badRequest, json } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { placeCall } from "@/lib/telephony/click-to-call";

export const POST = v1<{ id: string }>(
  async (_req, ctx, { id }) => {
    if (!isUuid(id)) throw badRequest("Invalid lead id");
    return json(await placeCall(ctx, id), 202);
  },
  { write: true },
);
