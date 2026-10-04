/**
 * Normalise an incoming lead from any source into one shape (DESIGN.md §3.2).
 *
 * Steps:
 *   1. Apply the source's field map (e.g. `{ full_name: "name",
 *      phone_number: "phone", city: "custom.city" }`).
 *   2. Anything unmapped goes to `custom` so no client data is lost.
 *   3. Phone → E.164 + 10-digit `phoneKey`; email lower-cased. A second
 *      number ("Mobile 2", "Alternate phone", or simply a second phone-like
 *      column) becomes `altPhone*`; an invalid or duplicate second number is
 *      dropped, never a reason to reject the lead.
 *   4. Reject when there is neither a valid phone nor an email.
 *
 * Pure function: no database, easy to unit-test with real source payloads.
 */
import { isValidMobile10, phoneKey as toPhoneKey, toE164 } from "@/lib/phone/phone";

export interface NormalisedLead {
  name?: string;
  phoneE164?: string;
  phoneKey?: string;
  altPhoneE164?: string;
  altPhoneKey?: string;
  email?: string;
  custom: Record<string, unknown>;
}

export type NormaliseResult = { ok: true; lead: NormalisedLead } | { ok: false; reason: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseLead(raw: Record<string, unknown>, fieldMap: Record<string, string> = {}): NormaliseResult {
  const mapped: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};

  for (const [sourceKey, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === "") continue;
    let target = fieldMap[sourceKey] ?? guessTarget(sourceKey);
    // Two phone-like columns ("Mobile", "Contact No") → the second is Mobile 2.
    if (target === "phone" && mapped.phone !== undefined && mapped.altPhone === undefined) target = "altPhone";
    if (target?.startsWith("custom.")) custom[target.slice(7)] = value;
    else if (target) mapped[target] = value;
    else custom[sourceKey] = value;
  }

  const key = toPhoneKey(mapped.phone);
  const validPhone = key !== "" && isValidMobile10(key) && toE164(mapped.phone) !== null;
  const email = typeof mapped.email === "string" ? mapped.email.trim().toLowerCase() : undefined;
  const validEmail = !!email && EMAIL_RE.test(email);

  const altKey = toPhoneKey(mapped.altPhone);
  const validAlt = altKey !== "" && isValidMobile10(altKey) && altKey !== key && toE164(mapped.altPhone) !== null;

  if (!validPhone && !validEmail) {
    return { ok: false, reason: "no valid phone or email" };
  }

  return {
    ok: true,
    lead: {
      name: typeof mapped.name === "string" ? mapped.name.trim() : undefined,
      phoneE164: validPhone ? (toE164(mapped.phone) ?? undefined) : undefined,
      phoneKey: validPhone ? key : undefined,
      altPhoneE164: validAlt ? (toE164(mapped.altPhone) ?? undefined) : undefined,
      altPhoneKey: validAlt ? altKey : undefined,
      email: validEmail ? email : undefined,
      custom,
    },
  };
}

/** Sensible defaults when a source has no explicit field map yet. */
function guessTarget(key: string): string | undefined {
  // Spreadsheet headers: "Full Name", "Mobile No.", "Email ID", "contact-number".
  const k = key.toLowerCase().trim().replace(/[\s\-.]+/g, "_").replace(/_+$/, "");
  if (/^(name|full_?name|(customer|lead|contact|client)_?name)$/.test(k)) return "name";
  const phoneLike = /(phone|mobile|contact_?no|contact_?number|whatsapp|^cell|^number$)/.test(k);
  if (phoneLike && /(alt|alternate|secondary|other|second|2nd|_?2$)/.test(k)) return "altPhone";
  if (phoneLike) return "phone";
  if (/e_?mail/.test(k)) return "email";
  return undefined;
}
