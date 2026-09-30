/**
 * Outbound webhook signatures (DESIGN.md §6.2).
 *
 * Header: `X-AM2PM-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`
 *
 * Including the timestamp in the signed string stops replay of an old body;
 * receivers reject anything older than 5 minutes. `verifySignature` is the
 * same code we give clients in our integration guide.
 */
import { hmacSha256Hex, safeEqualHex } from "@/lib/crypto";

export const SIGNATURE_HEADER = "X-AM2PM-Signature";
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, rawBody: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const v1 = hmacSha256Hex(secret, `${nowSeconds}.${rawBody}`);
  return `t=${nowSeconds},v1=${v1}`;
}

export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  if (!parts.v1) return false;
  return safeEqualHex(hmacSha256Hex(secret, `${t}.${rawBody}`), parts.v1);
}
