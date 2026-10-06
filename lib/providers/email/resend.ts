/**
 * Email adapter — Resend (RULE.md §10: providers only through lib/providers).
 *
 *   POST https://api.resend.com/emails  { from, to, subject, html, text }
 *   Authorization: Bearer RESEND_API_KEY; Idempotency-Key makes a retried
 *   send a no-op on Resend's side (24 h), so a repeated tick never doubles a digest.
 *
 * From: EMAIL_FROM (e.g. "AM2PM CRM <crm@am2pmsupport.com>") — its domain must
 * be verified in Resend. Without RESEND_API_KEY every send returns
 * { ok: false, code: "not_configured" } and nothing is attempted.
 * Only internal mail (staff digests) goes through here today; mail to
 * contacts needs channel consent first (CLAUDE.md "Don't").
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key → Resend sends once. */
  idempotencyKey?: string;
}

export type SendResult = { ok: true; id: string } | { ok: false; code: "not_configured" | "rejected" | "unreachable"; message: string };

const DEFAULT_FROM = "AM2PM CRM <crm@am2pmsupport.com>";

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export async function sendEmail(m: EmailMessage): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, code: "not_configured", message: "RESEND_API_KEY is not set" };
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(m.idempotencyKey ? { "idempotency-key": m.idempotencyKey.slice(0, 256) } : {}),
      },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || DEFAULT_FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, code: "unreachable", message: "Could not reach Resend" };
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (res.ok && body.id) return { ok: true, id: body.id };
  return { ok: false, code: "rejected", message: `Resend ${res.status}: ${body.message ?? body.name ?? "rejected"}`.slice(0, 200) };
}
