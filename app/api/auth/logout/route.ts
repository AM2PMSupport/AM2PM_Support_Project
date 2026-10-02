/** POST /api/auth/logout — clears the session cookie. */
import { SESSION_COOKIE } from "@/lib/auth/token";

export async function POST(): Promise<Response> {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
