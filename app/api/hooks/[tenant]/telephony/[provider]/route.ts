/**
 * POST /api/hooks/{tenant}/telephony/{provider} — call webhooks from the
 * cloud telephony provider, for BOTH inbound and outbound (click-to-call)
 * calls. There is no SIP endpoint anywhere in this app (RULE.md §6.1).
 *
 * Verify with the provider adapter → store → queue → 200. The call logic runs
 * in the "process-webhook" job (lib/telephony/call-events.ts).
 * GET is accepted too because some providers send call events as GET.
 */
import { and, eq } from "drizzle-orm";
import { integrations } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { handle, json, notFound, unauthorized } from "@/lib/http/errors";
import { tenantBySlug } from "@/lib/platform-admin/tenants";
import { telephonyAdapter } from "@/lib/telephony/registry";
import { systemContext } from "@/lib/tenancy/context";
import { parseWebhookBody, receiveWebhook } from "@/lib/webhooks/receive";

type Ctx = { params: Promise<{ tenant: string; provider: string }> };

async function receive(req: Request, { params }: Ctx): Promise<Response> {
  const { tenant: slug, provider } = await params;
  const tenant = await tenantBySlug(slug);
  const adapter = telephonyAdapter(provider);
  if (!tenant || !adapter) throw notFound();
  const ctx = systemContext(tenant);

  const [integration] = await withTenant(ctx, (tx) =>
    tx
      .select()
      .from(integrations)
      .where(and(eq(integrations.kind, "telephony"), eq(integrations.provider, provider), eq(integrations.status, "active"))),
  );
  if (!integration) throw notFound();

  const rawBody = req.method === "GET" ? "" : await req.text();
  const secret = integration.webhookSecretEnc ? decrypt(integration.webhookSecretEnc) : undefined;
  if (!(await adapter.verifyWebhook(req, rawBody, secret))) throw unauthorized("Invalid webhook signature");

  const payload = parseWebhookBody(req, rawBody);
  const { duplicate } = await receiveWebhook({
    ctx,
    source: `telephony:${provider}`,
    payload,
    // GET events have no body; hash the parsed params so retries dedupe.
    rawBody: rawBody || JSON.stringify(payload),
  });
  return json({ ok: true, duplicate });
}

export const POST = handle(receive);
export const GET = handle(receive);
