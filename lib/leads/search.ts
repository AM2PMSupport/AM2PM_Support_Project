/**
 * Quick search for contacts and their leads (DESIGN.md §2.5).
 *
 * The query string is classified so each search hits the index built for it:
 *
 *   "rahul@gm"      → email ILIKE '%rahul@gm%'   contacts_search_email (trigram GIN)
 *   "9811111111"    → phone_key = '9811111111'   contacts_tenant_phone (btree, exact)
 *   "4321", "98111" → phone_key ILIKE '%4321%'   contacts_search_phone (trigram GIN)
 *   (both also match Mobile 2: alt_phone_key, contacts_tenant_alt_phone / contacts_search_alt_phone)
 *   "Rah", "sharma" → name ILIKE '%rah%'         contacts_search_name  (trigram GIN),
 *                     ranked by similarity()
 *
 * Runs on a read replica (withTenantRead: least connections, primary
 * fallback) because it is a pure read, and inside RLS like everything else.
 * User text is escaped so % and _ are matched literally.
 */
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { contacts, leads } from "@/lib/db/schema";
import { withTenantRead } from "@/lib/db/tenant";
import { classifyQuery, escapeLike } from "@/lib/leads/search-classify";
import type { TenantContext } from "@/lib/tenancy/context";

// Re-exported so callers and tests keep one import path.
export { classifyQuery, escapeLike, type SearchKind } from "@/lib/leads/search-classify";


export interface SearchResult {
  contactId: string;
  name: string | null;
  phoneE164: string | null;
  email: string | null;
  dnc: boolean;
  leads: { id: string; processId: string; stage: string; status: string; assignedTo: string | null }[];
}

const MAX_LIMIT = 50;

export async function searchContacts(ctx: TenantContext, query: string, limit = 20): Promise<SearchResult[]> {
  const c = classifyQuery(query);
  if (!c) return [];
  const take = Math.min(Math.max(limit, 1), MAX_LIMIT);
  const pattern = `%${escapeLike(c.value)}%`;

  return withTenantRead(ctx, async (tx) => {
    const base = tx
      .select({ id: contacts.id, name: contacts.name, phoneE164: contacts.phoneE164, email: contacts.email, dnc: contacts.dnc })
      .from(contacts);

    const found =
      c.kind === "phone_exact"
        ? await base.where(or(eq(contacts.phoneKey, c.value), eq(contacts.altPhoneKey, c.value))).limit(take)
        : c.kind === "phone_partial"
          ? await base.where(or(ilike(contacts.phoneKey, pattern), ilike(contacts.altPhoneKey, pattern))).orderBy(desc(contacts.updatedAt)).limit(take)
          : c.kind === "email"
            ? await base.where(ilike(contacts.email, pattern)).orderBy(desc(contacts.updatedAt)).limit(take)
            : await base
                .where(ilike(contacts.name, pattern))
                .orderBy(desc(sql`similarity(${contacts.name}, ${c.value})`), desc(contacts.updatedAt))
                .limit(take);

    if (!found.length) return [];
    const leadRows = await tx
      .select({ id: leads.id, contactId: leads.contactId, processId: leads.processId, stage: leads.stage, status: leads.status, assignedTo: leads.assignedTo })
      .from(leads)
      .where(and(inArray(leads.contactId, found.map((f) => f.id)), eq(leads.isActive, true)))
      .orderBy(desc(leads.lastEnquiryAt));

    // TODO(T1.15): mask phone numbers for roles without unmask permission.
    return found.map((f) => ({
      contactId: f.id,
      name: f.name,
      phoneE164: f.phoneE164,
      email: f.email,
      dnc: f.dnc,
      leads: leadRows
        .filter((l) => l.contactId === f.id)
        .map(({ id, processId, stage, status, assignedTo }) => ({ id, processId, stage, status, assignedTo })),
    }));
  });
}
