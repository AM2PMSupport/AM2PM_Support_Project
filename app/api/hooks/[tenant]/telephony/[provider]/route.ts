/**
 * POST /api/hooks/{tenant}/telephony/{provider} — call webhooks from the
 * cloud telephony provider, for BOTH inbound and outbound (click-to-call)
 * calls. There is no SIP endpoint anywhere in this app (RULE.md §6.1).
 *
 * Verify with the provider adapter → store → queue → 200. The call logic runs
 * in the "process-webhook" job (lib/telephony/call-events.ts).
 * GET is accepted too because some providers send call events as GET.
 * The secret may be in the path (…/{provider}/{key}, see ./[key]/route.ts)
 * or in ?key= (older URLs).
 */
import { and, eq } from "drizzle-orm";
import { integrations } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { ApiError, handle, json, notFound, unauthorized } from "@/lib/http/errors";
import { log } from "@/lib/log";
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
  let secret: string | undefined;
  try {
    secret = integration.webhookSecretEnc ? decrypt(integration.webhookSecretEnc) : undefined;
  } catch {
    // Saved with a different MASTER_ENCRYPTION_KEY (e.g. configured from another environment).
    log.error("telephony webhook secret unreadable — MASTER_ENCRYPTION_KEY mismatch; reconnect telephony in Setup", { tenant: slug, provider });
    throw new ApiError(503, "secret_unreadable", "Webhook secret can't be read; reconnect telephony in Setup");
  }
  if (!(await adapter.verifyWebhook(req, rawBody, secret))) {
    // Explain the rejection without logging the key itself.
    const url = new URL(req.url);
    const pathTail = url.pathname.split(`/telephony/${provider}/`)[1] ?? "";
    const presented = pathTail || (url.searchParams.get("key") ?? "");
    log.warn("telephony webhook rejected", {
      tenant: slug,
      provider,
      method: req.method,
      // Field names avoid "key"/"secret" so the log redactor keeps them (values are lengths only).
      presentedVia: pathTail ? "path" : url.searchParams.has("key") ? "query" : "missing",
      presentedChars: presented.length,
      expectedChars: secret?.length ?? 0,
      maskedCopied: presented.includes("•") || presented.includes("%E2%80%A2") || presented.includes("[hidden]"),
      contentType: req.headers.get("content-type") ?? "",
      fields: Object.keys(parseWebhookBody(req, rawBody)).slice(0, 25),
    });
    throw unauthorized("Invalid webhook signature");
  }

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
