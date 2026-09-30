/**
 * Phone number rules ported from crmv7.gs (MEMORIE.md §6).
 *
 * - `toTenDigits`: strip everything but digits and keep the last 10.
 * - `phoneKey`: the dedupe/lookup key = last 10 digits, "" when too short.
 * - `isValidMobile10`: Indian mobile, starts 6–9.
 * - `toE164`: storage format (+91XXXXXXXXXX by default).
 * - `canonicalDid`: CallerDesk rejects a DID without its leading 0; recover
 *   the registered form from the tenant's DID list by matching last 10 digits.
 *
 * Pure functions, no I/O — unit-tested in tests/phone.test.ts.
 */

export function digitsOnly(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

export function toTenDigits(v: unknown): string {
  const d = digitsOnly(v);
  return d.length >= 10 ? d.slice(-10) : d;
}

export function phoneKey(v: unknown): string {
  const d = digitsOnly(v);
  return d.length >= 10 ? d.slice(-10) : "";
}

export function isValidMobile10(d: string): boolean {
  return /^[6-9]\d{9}$/.test(d);
}

/**
 * E.164 for storage. Numbers that already carry a country code (11+ digits,
 * not starting with 0) keep it; 10-digit numbers get `defaultCountryCode`.
 */
export function toE164(v: unknown, defaultCountryCode = "91"): string | null {
  let d = digitsOnly(v);
  if (d.startsWith("00")) d = d.slice(2); // international prefix
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1); // trunk 0
  if (d.length === 10) return `+${defaultCountryCode}${d}`;
  if (d.length > 10 && d.length <= 15) return `+${d}`;
  return null;
}

/** Returns the DID exactly as registered (e.g. "07971544878"), else the digits given. */
export function canonicalDid(did: unknown, registered: readonly string[]): string {
  const d = digitsOnly(did);
  if (!d) return d;
  const last10 = d.slice(-10);
  const match = registered.find((r) => digitsOnly(r).slice(-10) === last10);
  return match ?? d;
}

/** Masks all but the last 4 digits, for roles without unmask permission. */
export function maskPhone(v: unknown): string {
  const d = digitsOnly(v);
  if (d.length <= 4) return d;
  return `${"X".repeat(d.length - 4)}${d.slice(-4)}`;
}
