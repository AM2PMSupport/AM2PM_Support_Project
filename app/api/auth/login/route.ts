/**
 * POST /api/auth/login — email + password sign-in.
 *
 * - Body: JSON { email, password } (validated with Zod).
 * - Throttle: 5 failed attempts per email per 15 min, and 300 per IP, counted
 *   in Redis; over the limit → 429 even for a correct password. The per-IP
 *   ceiling is high on purpose: a whole call-centre floor (500+ agents) shares
 *   one office IP, and 30 typos at shift start used to lock everyone out
 *   (code review 2026-10-05). The per-email limit is the real guard.
 * - Same generic error for unknown email, wrong password or inactive user
 *   (no account enumeration). Password checked in constant time.
 * - Success: signed HttpOnly session cookie (12 h), SameSite=Lax, Secure in
 *   production. The password and its hash never leave this function.
 */
import { z } from "zod";
import { sha256Hex } from "@/lib/crypto";
import { verifyPassword } from "@/lib/auth/password";
import { sessionCookieHeader, sessionToken } from "@/lib/auth/cookie";
import { ApiError, badRequest, handle, json, unauthorized } from "@/lib/http/errors";
import { findAccount, membershipsOf, recordLogin } from "@/lib/platform-admin/auth";
import { homeFor } from "@/lib/auth/rbac";
import { grantsFor } from "@/lib/auth/grants";
import { redis } from "@/lib/redis/client";
import { log } from "@/lib/log";

const Body = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });
const WINDOW_SECONDS = 15 * 60;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 300;
// Burn the same time on unknown emails as on real ones (no timing oracle).
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function tooMany(key: string, limit: number): Promise<boolean> {
  const n = await redis().get<number>(key);
  return (n ?? 0) >= limit;
}

async function countFailure(...keys: string[]): Promise<void> {
  for (const key of keys) {
    const n = await redis().incr(key);
    if (n === 1) await redis().expire(key, WINDOW_SECONDS);
  }
}

export const POST = handle(async (req: Request) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Enter your email and password");
  const email = parsed.data.email.trim().toLowerCase();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";
  const emailKey = `login:fail:email:${sha256Hex(email)}`;
  const ipKey = `login:fail:ip:${sha256Hex(ip)}`;

  if ((await tooMany(emailKey, MAX_PER_EMAIL)) || (await tooMany(ipKey, MAX_PER_IP))) {
    throw new ApiError(429, "too_many_attempts", "Too many attempts. Try again in 15 minutes.");
  }

  const account = await findAccount(email);
  const ok = await verifyPassword(parsed.data.password, account?.passwordHash ?? DUMMY_HASH);
  // A correct password with no open workspace is still a generic failure (no enumeration).
  const memberships = account && ok ? await membershipsOf(account.id) : [];
  if (!account || !ok || !memberships.length) {
    await countFailure(emailKey, ipKey);
    log.warn("login failed", { emailHash: sha256Hex(email).slice(0, 12) });
    throw unauthorized("Email or password is incorrect", "invalid_credentials");
  }

  // Open the workspace used last; else the first (A→Z). Switch later from the sidebar.
  const m = memberships.find((x) => x.tenantId === account.lastTenantId) ?? memberships[0]!;
  await redis().del(emailKey);
  await recordLogin(account.id, m.userId, m.tenantId);

  const res = json({ ok: true, role: m.role, name: m.name, workspace: m.tenantName, home: homeFor({ role: m.role, grants: await grantsFor({ tenantId: m.tenantId, tenantSlug: m.tenantSlug, timezone: m.tenantTimezone }, m.role) }) });
  res.headers.append("Set-Cookie", sessionCookieHeader(sessionToken(account.id, m)));
  return res;
});
