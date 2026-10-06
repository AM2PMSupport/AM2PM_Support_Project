/**
 * Backup file format + retention — pure (T1.43–T1.44, ARCHITECTURE.md §7).
 *
 * One file = one batch (≤ 5,000 rows) of one table:
 *   NDJSON → gzip → AES-256-GCM with the snapshot's own 32-byte data key
 *   bytes: "AMB1" | iv (12) | tag (16) | ciphertext
 * The data key is stored only encrypted under the master key (envelope), so
 * the backup store alone is useless without MASTER_ENCRYPTION_KEY.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const MAGIC = Buffer.from("AMB1");

export function newDataKey(): Buffer {
  return randomBytes(32);
}

export function sealChunk(rows: unknown[], key: Buffer): Buffer {
  const plain = gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n"), "utf8"));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

export function openChunk(buf: Buffer, key: Buffer): Record<string, unknown>[] {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("Not an AM2PM backup file");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  const text = gunzipSync(Buffer.concat([d.update(buf.subarray(32)), d.final()])).toString("utf8");
  return text ? text.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

export interface RetentionPolicy {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

/**
 * Which COMPLETED snapshots to delete. Keeps the newest `keepDaily` days,
 * the newest snapshot of each of the last `keepWeekly` ISO weeks and of each
 * of the last `keepMonthly` months. `day` is yyyy-mm-dd.
 */
export function pruneList(snaps: { id: string; day: string }[], p: RetentionPolicy): string[] {
  const sorted = [...snaps].sort((a, b) => b.day.localeCompare(a.day));
  const keep = new Set(sorted.slice(0, Math.max(1, p.keepDaily)).map((s) => s.id));
  const week = (d: string) => {
    const t = new Date(`${d}T00:00:00Z`);
    const day = (t.getUTCDay() + 6) % 7; // Monday = 0
    return new Date(t.getTime() - day * 86_400_000).toISOString().slice(0, 10);
  };
  const firstOf = (key: (d: string) => string, n: number) => {
    const seen = new Set<string>();
    for (const s of sorted) {
      const k = key(s.day);
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > n) break;
      keep.add(s.id);
    }
  };
  firstOf(week, p.keepWeekly);
  firstOf((d) => d.slice(0, 7), p.keepMonthly);
  return sorted.filter((s) => !keep.has(s.id)).map((s) => s.id);
}
