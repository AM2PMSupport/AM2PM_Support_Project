/**
 * The backup store: a SEPARATE private Vercel Blob store (`am2pm-crm-backups`,
 * bom1) reached with BACKUP_READ_WRITE_TOKEN — not the store that holds
 * recordings and imports (owner decision 2026-10-06; Cloudflare R2 later).
 * Files are already encrypted (lib/backups/format.ts); private access on top.
 */
import { del, get, put } from "@vercel/blob";

const token = () => process.env.BACKUP_READ_WRITE_TOKEN;

export function backupStoreConfigured(): boolean {
  return !!token();
}

export async function putBackupFile(pathname: string, body: Buffer): Promise<void> {
  await put(pathname, body, { access: "private", token: token(), contentType: "application/octet-stream", addRandomSuffix: false, allowOverwrite: true });
}

export async function readBackupFile(pathname: string): Promise<Buffer> {
  const res = await get(pathname, { access: "private", token: token(), useCache: false });
  if (!res) throw new Error(`backup file missing: ${pathname}`);
  return Buffer.from(await new Response(res.stream).arrayBuffer());
}

export async function deleteBackupFiles(pathnames: string[]): Promise<void> {
  for (let i = 0; i < pathnames.length; i += 100) await del(pathnames.slice(i, i + 100), { token: token() });
}
