/**
 * POST /api/v1/leads/{id}/call — the agent's Call button.
 *
 * Starts an API click-to-call: the provider rings the agent's own phone,
 * then the customer (lib/telephony/click-to-call.ts). Returns immediately
 * with the interaction id; live status arrives over SSE from webhooks.
 *
 * Optional body `{ "number": "alt" }` dials the contact's Mobile 2;
 * default (no body) is the main number.
 *
 * 409 already_on_call · 403 dnc / not your lead · 422 setup missing ·
 * 502 provider rejected (message is safe to show the agent).
 */
import { z } from "zod";
import { isUuid } from "@/lib/db/tenant";
import { badRequest, json } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { placeCall } from "@/lib/telephony/click-to-call";

const CallBody = z.object({ number: z.enum(["primary", "alt"]).default("primary") });

export const POST = v1<{ id: string }>(
  async (req, ctx, { id }) => {
    if (!isUuid(id)) throw badRequest("Invalid lead id");
    // Body is optional (older callers send none).
    const text = await req.text();
    let raw: unknown = {};
    try {
      if (text.trim()) raw = JSON.parse(text);
    } catch {
      throw badRequest("Body must be JSON", "invalid_json");
    }
    const body = CallBody.parse(raw);
    return json(await placeCall(ctx, id, body.number), 202);
  },
  { write: true },
);
