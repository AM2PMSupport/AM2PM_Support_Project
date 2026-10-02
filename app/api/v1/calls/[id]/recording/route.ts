/**
 * GET /api/v1/calls/{id}/recording — play a call recording.
 *
 * Only for people who may see that call (callScope: agents their own calls,
 * supervisors their processes, admins all). Streams our private Blob copy;
 * until the copy exists, proxies CallerDesk's file (https on *.callerdesk.io
 * only) with Range passthrough so the player can seek. The provider URL never
 * reaches the browser. Starting playback is audited. API.md §3.9.
 */
import { and, eq } from "drizzle-orm";
import { interactions } from "@/lib/db/schema";
import { withTenant, isUuid } from "@/lib/db/tenant";
import { requirePermission } from "@/lib/auth/rbac";
import { notFound } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { callScope } from "@/lib/calls/list";
import { streamPrivateBlob } from "@/lib/storage/blob";
import { isAllowedRecordingUrl } from "@/lib/telephony/recordings";
import { writeAudit } from "@/lib/audit";

export const GET = v1<{ id: string }>(async (req, ctx, { id }) => {
  requirePermission(ctx, "interactions", "V");
  if (!isUuid(id)) throw notFound();
  const [call] = await withTenant(ctx, (tx) =>
    tx
      .select({ key: interactions.recordingKey, url: interactions.recordingUrl })
      .from(interactions)
      .where(and(eq(interactions.id, id), eq(interactions.type, "call"), callScope(ctx))),
  );
  if (!call || (!call.key && !call.url)) throw notFound("No recording for this call");

  const range = req.headers.get("range");
  if (!range || /^bytes=0-/.test(range)) {
    await withTenant(ctx, (tx) => writeAudit(tx, ctx, { action: "recording.played", entity: "interaction", entityId: id }));
  }
  const headers = { "cache-control": "private, no-store", "content-disposition": "inline" };

  if (call.key) {
    const blob = await streamPrivateBlob(call.key);
    if (blob) {
      return new Response(blob.stream, {
        headers: { ...headers, "content-type": blob.contentType, ...(blob.size ? { "content-length": String(blob.size) } : {}) },
      });
    }
  }
  if (!call.url || !isAllowedRecordingUrl(call.url)) throw notFound("Recording not available");
  const upstream = await fetch(call.url, { headers: range ? { range } : {}, signal: AbortSignal.timeout(30_000) });
  if (!upstream.ok && upstream.status !== 206) throw notFound("Recording not available from CallerDesk");
  const pass: Record<string, string> = { ...headers };
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) pass[h] = v;
  }
  if (!pass["content-type"] || pass["content-type"].startsWith("application/octet")) pass["content-type"] = "audio/wav";
  return new Response(upstream.body, { status: upstream.status, headers: pass });
});
