/**
 * GET /api/health — liveness of the app's dependencies, for uptime monitors.
 *
 * Returns only up/down booleans and latencies, never error text, hostnames
 * or credentials, so it is safe to leave public. 200 when everything is up,
 * 503 otherwise.
 */
import { pingDatabase, pingRedis, replicas } from "@/lib/platform-admin/health";

export const dynamic = "force-dynamic";

async function timed(check: () => Promise<unknown>): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  try {
    await Promise.race([check(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000))]);
    return { ok: true, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  }
}

export async function GET(): Promise<Response> {
  const [database, cache] = await Promise.all([
    timed(pingDatabase),
    timed(pingRedis),
  ]);
  const ok = database.ok && cache.ok;
  return Response.json({ ok, database, redis: cache, replicas: replicas() }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
