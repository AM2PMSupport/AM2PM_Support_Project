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
import { requireSession } from "@/lib/auth/session";
import { isUuid } from "@/lib/db/tenant";
import { badRequest, handle, json } from "@/lib/http/errors";
import { placeCall } from "@/lib/telephony/click-to-call";

export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSession(req);
  const { id } = await params;
  if (!isUuid(id)) throw badRequest("Invalid lead id");
  const result = await placeCall(ctx, id);
  return json(result, 202);
});
