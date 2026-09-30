/**
 * POST /api/hooks/{tenant}/{sourceId} — lead-source webhook (web forms,
 * Google Ads, portals, partners).
 *
 * Auth: the source key, sent as header `x-source-key` or `?key=`. We store
 * only its SHA-256 (shown once at creation) and compare in constant time.
 * Then: store + queue + 200 (lib/webhooks/receive.ts). No lead logic here.
 */
import { and, eq } from "drizzle-orm";
import { importSources } from "@/lib/db/schema";
import { isUuid, withTenant } from "@/lib/db/tenant";
import { safeEqualHex, sha256Hex } from "@/lib/crypto";
import { handle, json, notFound, unauthorized } from "@/lib/http/errors";
import { tenantBySlug } from "@/lib/platform-admin/tenants";
import { systemContext } from "@/lib/tenancy/context";
import { parseWebhookBody, receiveWebhook } from "@/lib/webhooks/receive";

export const POST = handle(async (req: Request, { params }: { params: Promise<{ tenant: string; source: string }> }) => {
  const { tenant: slug, source: sourceId } = await params;
  const tenant = await tenantBySlug(slug);
  if (!tenant || !isUuid(sourceId)) throw notFound();
  const ctx = systemContext(tenant);

  const [source] = await withTenant(ctx, (tx) =>
    tx
      .select({ secretHash: importSources.secretHash })
      .from(importSources)
      .where(and(eq(importSources.id, sourceId), eq(importSources.status, "active"))),
  );
  if (!source) throw notFound();

  const key = req.headers.get("x-source-key") ?? new URL(req.url).searchParams.get("key") ?? "";
  if (!key || !safeEqualHex(sha256Hex(key), source.secretHash)) throw unauthorized("Invalid source key");

  const rawBody = await req.text();
  const payload = parseWebhookBody(req, rawBody);
  const { duplicate } = await receiveWebhook({ ctx, source: `source:${sourceId}`, payload, rawBody });
  return json({ ok: true, duplicate });
});
