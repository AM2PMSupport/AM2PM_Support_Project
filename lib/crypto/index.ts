/**
 * Crypto helpers (RULE.md §5).
 *
 * - encrypt/decrypt: AES-256-GCM for provider credentials, webhook secrets and
 *   backup data keys. Output is "v1.<iv>.<tag>.<ciphertext>" in base64url so
 *   the format can be rotated later (bump the version prefix).
 * - hmacSha256Hex / verifyHmac: outbound webhook signatures.
 * - sha256Hex: idempotency keys and hashed source keys.
 * - randomToken: secrets shown once to an admin.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { securityEnv } from "@/lib/config/env";

const ALGO = "aes-256-gcm";
const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

function masterKey(): Buffer {
  return Buffer.from(securityEnv().MASTER_ENCRYPTION_KEY, "base64");
}

/** Encrypts UTF-8 text. `key` defaults to the master key (32 bytes). */
export function encrypt(plain: string, key: Buffer = masterKey()): string {
  const iv = randomBytes(12); // 96-bit IV, the GCM standard
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(".");
}

export function decrypt(token: string, key: Buffer = masterKey()): string {
  const [version, iv, tag, ct] = token.split(".");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported ciphertext format");
  const decipher = createDecipheriv(ALGO, key, fromB64u(iv));
  decipher.setAuthTag(fromB64u(tag));
  return Buffer.concat([decipher.update(fromB64u(ct)), decipher.final()]).toString("utf8");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time comparison of two hex strings (avoids timing attacks). */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32): string {
  return b64u(randomBytes(bytes));
}
