/**
 * Private Vercel Blob store `am2pm-crm-blob` (bom1): uploaded import files,
 * later call recordings (T1.39). Every object is PRIVATE — read through the
 * server with BLOB_READ_WRITE_TOKEN, never by a public URL. Keys are always
 * prefixed with the tenant id so one tenant can never name another's file.
 */
import { del, get, put } from "@vercel/blob";

export function tenantPrefix(tenantId: string, area: "imports" | "recordings"): string {
  return `${area}/${tenantId}/`;
}

export async function readPrivateBlob(pathname: string): Promise<Buffer> {
  const res = await get(pathname, { access: "private", useCache: false });
  if (!res) throw new Error("file not found in storage");
  return Buffer.from(await new Response(res.stream).arrayBuffer());
}

export async function deletePrivateBlob(pathname: string): Promise<void> {
  await del(pathname);
}

/** Store a private object at an exact path (overwrites; used for recordings). */
export async function putPrivateBlob(pathname: string, body: ReadableStream | Blob | Buffer, contentType: string): Promise<void> {
  await put(pathname, body, { access: "private", contentType, addRandomSuffix: false, allowOverwrite: true, multipart: true });
}

/** Stream a private object (for playback through an authorised route). */
export async function streamPrivateBlob(pathname: string): Promise<{ stream: ReadableStream; contentType: string; size?: number } | null> {
  const res = await get(pathname, { access: "private" });
  if (!res?.stream) return null;
  return { stream: res.stream, contentType: res.blob.contentType ?? "audio/wav", size: res.blob.size ?? undefined };
}
