/**
 * Session cookie for one workspace membership. Used by sign-in and by the
 * workspace switcher, so both issue exactly the same cookie.
 */
import { authEnv } from "@/lib/config/env";
import { createToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/token";
import type { Membership } from "@/lib/platform-admin/auth";

export function sessionToken(accountId: string, m: Membership): string {
  return createToken({ aid: accountId, uid: m.userId, tid: m.tenantId, slug: m.tenantSlug, tname: m.tenantName, tz: m.tenantTimezone, role: m.role, name: m.name }, authEnv().AUTH_SECRET);
}

export const sessionCookieOptions = {
  name: SESSION_COOKIE,
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
  secure: process.env.NODE_ENV === "production",
};

export function sessionCookieHeader(token: string): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_TTL_SECONDS}`, process.env.NODE_ENV === "production" ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");
}
