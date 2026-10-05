/**
 * POST /api/auth/logout — clears the session cookie and records `auth.logout`
 * in the workspace's audit log (Reports → Agents: logout time). Recording is
 * best effort: signing out never fails because of it.
 */
import { getSession } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/token";
import { withTenant } from "@/lib/db/tenant";
import { writeAudit } from "@/lib/audit";
import { log } from "@/lib/log";

export async function POST(): Promise<Response> {
  try {
    const ctx = await getSession();
    if (ctx) await withTenant(ctx, (tx) => writeAudit(tx, ctx, { action: "auth.logout", entity: "user", entityId: ctx.actor.userId }));
  } catch (err) {
    log.warn("logout not recorded", { err });
  }
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
