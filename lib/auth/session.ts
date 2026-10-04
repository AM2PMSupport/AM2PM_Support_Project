/**
 * Session → TenantContext.
 *
 * Sign-in is email + password (lib/auth/password.ts); the session is a signed
 * HttpOnly cookie (lib/auth/token.ts). tenantId comes ONLY from this verified
 * cookie, never from a request body (RULE.md §1.7).
 *
 *   requireSession(req)  — API route handlers (reads the Cookie header)
 *   getSession()         — server components / layouts (next/headers)
 *
 * Both attach the actor's effective permissions for this workspace
 * (lib/auth/grants.ts), so every check honours Setup → Roles edits.
 *
 * Google sign-in and email OTP (original T1.11 plan) can be added later as
 * extra ways to obtain the same cookie.
 */
import { cookies } from "next/headers";
import { authEnv } from "@/lib/config/env";
import { unauthorized } from "@/lib/http/errors";
import { readToken, SESSION_COOKIE, type SessionPayload } from "@/lib/auth/token";
import type { TenantContext } from "@/lib/tenancy/context";
import { grantsFor } from "@/lib/auth/grants";

export interface SessionContext extends TenantContext {
  actor: NonNullable<TenantContext["actor"]>;
  /** The person's login (accounts.id) — used only for switching workspaces. */
  accountId: string;
  /** Workspace display name (falls back to the slug for older cookies). */
  tenantName: string;
}

function toContext(p: SessionPayload): SessionContext {
  return { tenantId: p.tid, tenantSlug: p.slug, timezone: p.tz, accountId: p.aid, tenantName: p.tname ?? p.slug, actor: { userId: p.uid, role: p.role, name: p.name } };
}

async function withGrants(ctx: SessionContext): Promise<SessionContext> {
  ctx.actor.grants = await grantsFor(ctx, ctx.actor.role);
  return ctx;
}

function cookieFromHeader(header: string | null): string | undefined {
  return header
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

export async function requireSession(req: Request): Promise<SessionContext> {
  const payload = readToken(cookieFromHeader(req.headers.get("cookie")), authEnv().AUTH_SECRET);
  if (!payload) throw unauthorized("Please sign in", "unauthorized");
  return withGrants(toContext(payload));
}

export async function getSession(): Promise<SessionContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const payload = readToken(token, authEnv().AUTH_SECRET);
  return payload ? withGrants(toContext(payload)) : null;
}
