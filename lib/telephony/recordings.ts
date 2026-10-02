/**
 * Call recordings (T1.39).
 *
 * CallerDesk sends `CallRecordingUrl` in the Call Report webhook (and `file`
 * in its Call Report API). We COPY each recording into our private Blob store
 * (recordings/<tenantId>/<yyyy>/<mm>/<interactionId>.<ext>) so it survives the
 * provider's retention and is only ever played through
 * /api/v1/calls/{id}/recording, which checks who may hear it. The provider
 * URL is kept as a fallback until the copy exists.
 *
 * SSRF guard: we only fetch https URLs on CallerDesk's recording hosts — a
 * forged webhook can't make the server download arbitrary URLs.
 */
import { eq } from "drizzle-orm";
import { interactions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { TenantContext } from "@/lib/tenancy/context";
import { putPrivateBlob, tenantPrefix } from "@/lib/storage/blob";
import { log } from "@/lib/log";

const MAX_BYTES = 60 * 1024 * 1024; // ~1 h of 8 kHz WAV
const ALLOWED_HOST = /(^|\.)callerdesk\.io$/i;

export function isAllowedRecordingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

function extOf(url: string, contentType: string): string {
  const fromUrl = /\.(wav|mp3|ogg|m4a)(\?|$)/i.exec(url)?.[1]?.toLowerCase();
  if (fromUrl) return fromUrl;
  if (/mpeg|mp3/.test(contentType)) return "mp3";
  if (/ogg/.test(contentType)) return "ogg";
  return "wav";
}

export function contentTypeFor(ext: string): string {
  return ext === "mp3" ? "audio/mpeg" : ext === "ogg" ? "audio/ogg" : ext === "m4a" ? "audio/mp4" : "audio/wav";
}

/** Copy one call's recording into Blob. Idempotent: does nothing once copied. */
export async function copyRecording(ctx: TenantContext, interactionId: string): Promise<"copied" | "already" | "none" | "refused"> {
  const [call] = await withTenant(ctx, (tx) =>
    tx.select({ url: interactions.recordingUrl, key: interactions.recordingKey, startedAt: interactions.startedAt }).from(interactions).where(eq(interactions.id, interactionId)),
  );
  if (!call?.url) return "none";
  if (call.key) return "already";
  if (!isAllowedRecordingUrl(call.url)) {
    log.warn("recording url refused (not a CallerDesk host)", { tenant: ctx.tenantSlug, interactionId });
    return "refused";
  }

  const res = await fetch(call.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`recording download failed: HTTP ${res.status}`); // QStash retries
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > MAX_BYTES) {
    log.warn("recording too large to copy; keeping provider link", { tenant: ctx.tenantSlug, interactionId, size });
    return "refused";
  }
  const type = res.headers.get("content-type") ?? "";
  const ext = extOf(call.url, type);
  const d = call.startedAt;
  const key = `${tenantPrefix(ctx.tenantId, "recordings")}${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${interactionId}.${ext}`;
  await putPrivateBlob(key, res.body, contentTypeFor(ext));
  await withTenant(ctx, (tx) => tx.update(interactions).set({ recordingKey: key }).where(eq(interactions.id, interactionId)));
  return "copied";
}
