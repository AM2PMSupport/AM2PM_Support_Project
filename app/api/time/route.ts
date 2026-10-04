/**
 * GET /api/time — the server's clock, public.
 *
 * The login-page watch uses it to correct a wrong device clock (agents'
 * PCs drift, and a CRM about callbacks should show the real time). Vercel
 * hosts are NTP-synced. Returns only epoch ms; never cached.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
