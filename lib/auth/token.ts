/**
 * Signed session tokens (pure — unit-tested).
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payload))
 * The cookie holds only ids, role and expiry — no secrets, no PII beyond the
 * display name. Tampering breaks the signature; expiry is enforced on read.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "@/lib/db/schema";

export interface SessionPayload {
  aid: string; // account id (the person's login, across workspaces)
  uid: string; // user id (membership in this workspace)
  tid: string; // tenant id
  slug: string; // tenant slug
  tname?: string; // workspace display name (switcher label)
  tz: string; // tenant timezone
  role: Role;
  name: string;
  exp: number; // unix seconds
}

export const SESSION_COOKIE = "am2pm_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12-hour shifts (ARCHITECTURE.md §6)

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createToken(payload: Omit<SessionPayload, "exp">, secret: string, now = Date.now()): string {
  const full: SessionPayload = { ...payload, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
  const data = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${data}.${sign(data, secret)}`;
}

export function readToken(token: string | undefined | null, secret: string, now = Date.now()): SessionPayload | null {
  if (!token) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = Buffer.from(sign(data, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString()) as SessionPayload;
    if (typeof p.exp !== "number" || p.exp * 1000 <= now) return null;
    if (typeof p.aid !== "string") return null; // pre-accounts cookie: sign in again
    return p;
  } catch {
    return null;
  }
}
