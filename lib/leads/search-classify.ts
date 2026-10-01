/**
 * Query classification for quick search — pure, no I/O, safe in the browser.
 * Shared by the server search (lib/leads/search.ts) and the UI search box so
 * both interpret what a user types identically (DESIGN.md §2.5).
 */
import { digitsOnly, toTenDigits } from "@/lib/phone/phone";

export type SearchKind = "email" | "phone_exact" | "phone_partial" | "name";

/** Decide which index a query should use. Pure — unit-tested. Null = too short to search. */
export function classifyQuery(raw: string): { kind: SearchKind; value: string } | null {
  const q = raw.trim();
  if (q.includes("@")) return q.length >= 3 ? { kind: "email", value: q.toLowerCase() } : null;
  const digits = digitsOnly(q);
  // Digits (allowing spaces, +, -, brackets) → phone search; under 3 digits is too vague.
  if (/^[\d\s+()-]+$/.test(q)) {
    if (digits.length < 3) return null;
    return digits.length >= 10 ? { kind: "phone_exact", value: toTenDigits(digits) } : { kind: "phone_partial", value: digits };
  }
  return q.length >= 2 ? { kind: "name", value: q } : null;
}

/** Escape LIKE wildcards so user input is matched literally. */
export function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}
