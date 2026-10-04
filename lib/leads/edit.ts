/**
 * Edit, delete (Recycle bin) and restore leads — the Leads screen's row
 * actions.
 *
 * Edit: contact details (name / phone / email are the CONTACT's, shared by
 * every lead of that person), custom fields validated against the
 * process's definitions, then stage and owner through the normal paths
 * (setStage, bulkAssign) so events, capacity and conversions stay right.
 * Only roles that see full numbers may change the phone or Mobile 2. If the change moves
 * the dedupe value onto another open lead, the update runs in a SAVEPOINT
 * and is refused with 409 — never a caught error inside the outer
 * transaction (RULE.md §2.1).
 *
 * Delete (leads "D": admins): soft — deleted_at/deleted_by, is_active=false
 * (frees the dedupe key), pending callbacks cancelled, owner's capacity
 * released, lead_events + audit. Restore puts it back unless another open
 * lead now holds the same dedupe key.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { callbacks, contacts, customFieldDefinitions, leadEvents, leads, processes, users } from "@/lib/db/schema";
import { withTenant, isUniqueViolation, type Tx } from "@/lib/db/tenant";
import { canReassign, canSeeFullPhone, requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { leadScopeCondition } from "@/lib/leads/scope";
import { validateCustom } from "@/lib/admin/custom-fields";
import { isValidMobile10, phoneKey, toE164 } from "@/lib/phone/phone";
import { displayPhone } from "@/lib/agent/queue";
import { setStage } from "@/lib/agent/outcome";
import { bulkAssign } from "@/lib/leads/bulk";
import { writeAudit } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/http/errors";

/**
 * Partial update: anything omitted stays as it is (the console saves one
 * field at a time; the lead page /leads/{id} sends the whole form). `custom` keys
 * merge into the lead; an empty string clears that key.
 */
export const EditLeadInput = z.object({
  leadId: z.uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(20).optional(),
  /** Mobile 2; "" clears it. */
  altPhone: z.string().trim().max(20).optional(),
  email: z.string().trim().max(254).optional(),
  campaign: z.string().trim().max(120).optional(),
  stage: z.string().trim().min(1).max(30).optional(),
  ownerId: z.uuid().nullable().optional(),
  custom: z.record(z.string().max(60), z.string().max(500)).default({}),
});

/** Data for the lead page form (app/(app)/leads/[id]). */
export async function getLeadForEdit(ctx: SessionContext, leadId: string) {
  requirePermission(ctx, "leads", "E");
  return withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select({ lead: leads, contact: contacts, processName: processes.name, stages: processes.stages })
      .from(leads)
      .innerJoin(contacts, eq(contacts.id, leads.contactId))
      .innerJoin(processes, eq(processes.id, leads.processId))
      .where(and(eq(leads.id, leadId), isNull(leads.deletedAt), leadScopeCondition(ctx)));
    if (!r) throw notFound("Lead not found");
    const fields = await tx
      .select({ key: customFieldDefinitions.key, label: customFieldDefinitions.label, type: customFieldDefinitions.type, options: customFieldDefinitions.options, required: customFieldDefinitions.required })
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.isActive, true), eq(customFieldDefinitions.entity, "lead"), or(eq(customFieldDefinitions.processId, r.lead.processId), isNull(customFieldDefinitions.processId))));
    const fullPhone = canSeeFullPhone(ctx.actor.role);
    return {
      id: r.lead.id,
      name: r.contact.name ?? "",
      phone: fullPhone ? (r.contact.phoneE164 ?? "") : displayPhone(ctx.actor.role, r.contact.phoneE164),
      altPhone: fullPhone ? (r.contact.altPhoneE164 ?? "") : r.contact.altPhoneE164 ? displayPhone(ctx.actor.role, r.contact.altPhoneE164) : "",
      canEditPhone: fullPhone,
      email: r.contact.email ?? "",
      campaign: r.lead.source.campaign ?? "",
      source: r.lead.source.kind,
      stage: r.lead.stage,
      stages: r.stages,
      status: r.lead.status,
      ownerId: r.lead.assignedTo,
      canChangeOwner: canReassign(ctx.actor),
      processName: r.processName,
      custom: Object.fromEntries(Object.entries(r.lead.custom).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])),
      fields,
    };
  });
}

export type LeadForEdit = Awaited<ReturnType<typeof getLeadForEdit>>;

export async function updateLead(ctx: SessionContext, raw: z.input<typeof EditLeadInput>) {
  requirePermission(ctx, "leads", "E");
  const input = EditLeadInput.parse(raw);
  const mayChangePhone = input.phone !== undefined && canSeeFullPhone(ctx.actor.role);
  const key = mayChangePhone && input.phone ? phoneKey(input.phone) : "";
  const mayChangeAlt = input.altPhone !== undefined && canSeeFullPhone(ctx.actor.role);
  const altKey = mayChangeAlt && input.altPhone ? phoneKey(input.altPhone) : "";
  const emailIn = input.email?.toLowerCase();
  if (emailIn && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailIn)) throw badRequest("Enter a valid email");

  const before = await withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select({ lead: leads, contact: contacts, dedupeField: processes.dedupeField })
      .from(leads)
      .innerJoin(contacts, eq(contacts.id, leads.contactId))
      .innerJoin(processes, eq(processes.id, leads.processId))
      .where(and(eq(leads.id, input.leadId), isNull(leads.deletedAt), leadScopeCondition(ctx)))
      .for("update", { of: leads });
    if (!r) throw notFound("Lead not found");
    // Only a CHANGED number is validated/saved (the form re-sends the current one).
    // Compares the E.164 too, and a typed number with no E.164 always counts as a change
    // (→ validated and refused), so a half-stored number can't be saved or kept.
    const numberEdited = (typed: string | undefined, k: string, storedKey: string | null, storedE164: string | null) =>
      (k || null) !== storedKey || (typed ? toE164(typed) : null) !== storedE164 || (!!typed && !toE164(typed));
    const phoneChange = mayChangePhone && numberEdited(input.phone, key, r.contact.phoneKey, r.contact.phoneE164);
    // Valid = a 6–9 mobile AND a storable E.164 (19 pasted digits have a valid "last 10" but no E.164).
    if (phoneChange && input.phone && (!isValidMobile10(key) || !toE164(input.phone))) throw badRequest("Enter a valid 10-digit mobile number");
    const nextPhone = phoneChange ? (input.phone ? toE164(input.phone) : null) : r.contact.phoneE164;
    const nextKey = phoneChange ? key || null : r.contact.phoneKey;
    const altChange = mayChangeAlt && numberEdited(input.altPhone, altKey, r.contact.altPhoneKey, r.contact.altPhoneE164);
    if (altChange && input.altPhone && (!isValidMobile10(altKey) || !toE164(input.altPhone))) throw badRequest("Enter a valid 10-digit mobile number for Mobile 2");
    const nextAlt = altChange ? (input.altPhone ? toE164(input.altPhone) : null) : r.contact.altPhoneE164;
    const nextAltKey = altChange ? altKey || null : r.contact.altPhoneKey;
    if (nextAltKey && nextAltKey === nextKey) throw badRequest("Mobile 2 is the same as the main number");
    const email = emailIn ?? r.contact.email ?? "";
    const name = input.name ?? r.contact.name ?? "";
    if (!nextPhone && !email) throw badRequest("A lead needs a phone number or an email");

    // Custom fields: validate against this process's definitions.
    const defs = await tx.select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.entity, "lead"), or(eq(customFieldDefinitions.processId, r.lead.processId), isNull(customFieldDefinitions.processId))));
    const merged = { ...r.lead.custom, ...input.custom };
    for (const [k, v] of Object.entries(input.custom)) if (v === "") delete merged[k];
    const { value: custom, errors } = validateCustom(defs, merged);
    if (errors.length) throw badRequest(errors[0]!);

    await tx.update(contacts).set({ name, phoneE164: nextPhone, phoneKey: nextKey, altPhoneE164: nextAlt, altPhoneKey: nextAltKey, email: email || null }).where(eq(contacts.id, r.contact.id));

    // Dedupe key moves only when the deduped value itself was edited. Leads keyed
    // "nokey:" at intake (e.g. an invalid number) must stay editable — re-keying
    // them on an unrelated edit (name, Mobile 2) would collide with a twin lead.
    const dedupeEdited =
      r.dedupeField === "phoneKey" ? phoneChange : r.dedupeField === "email" ? (r.contact.email ?? "") !== email : String(r.lead.custom[r.dedupeField] ?? "") !== String(custom[r.dedupeField] ?? "");
    if (dedupeEdited) {
      const nextDedupe = r.dedupeField === "phoneKey" ? nextKey : r.dedupeField === "email" ? email || null : custom[r.dedupeField] != null ? String(custom[r.dedupeField]).trim().toLowerCase() : null;
      const dedupeKey = nextDedupe ?? (r.lead.dedupeKey.startsWith("nokey:") ? r.lead.dedupeKey : `nokey:${crypto.randomUUID()}`);
      if (dedupeKey !== r.lead.dedupeKey) await moveDedupeKey(tx, r.lead.id, dedupeKey);
    }
    const source = input.campaign === undefined ? r.lead.source : { ...r.lead.source, campaign: input.campaign || undefined };
    await tx.update(leads).set({ custom, source }).where(eq(leads.id, r.lead.id));

    const changed = [
      r.contact.name !== name && "name",
      input.campaign !== undefined && (r.lead.source.campaign ?? "") !== input.campaign && "campaign",
      phoneChange && r.contact.phoneE164 !== nextPhone && "phone",
      altChange && r.contact.altPhoneE164 !== nextAlt && "mobile 2",
      (r.contact.email ?? "") !== email && "email",
      JSON.stringify(r.lead.custom) !== JSON.stringify(custom) && "custom fields",
    ].filter(Boolean) as string[];
    if (changed.length) {
      await tx.insert(leadEvents).values({ leadId: r.lead.id, type: "edited", actor: { kind: "user", id: ctx.actor.userId, name: ctx.actor.name }, after: { changed } });
    }
    return { stage: r.lead.stage, status: r.lead.status, ownerId: r.lead.assignedTo };
  });

  // Stage and owner through their own paths (events, capacity, conversion).
  if (input.stage && input.stage !== before.stage && before.status === "open") await setStage(ctx, { leadId: input.leadId, stage: input.stage });
  if (input.ownerId && input.ownerId !== before.ownerId && canReassign(ctx.actor)) {
    const r = await bulkAssign(ctx, { leadIds: [input.leadId], ownerId: input.ownerId });
    if (!r.moved) throw badRequest("That agent isn't mapped to this lead's process");
  }
}

/** Change a lead's dedupe key inside a SAVEPOINT so a collision doesn't abort the outer transaction. */
async function moveDedupeKey(tx: Tx, leadId: string, dedupeKey: string) {
  try {
    await tx.transaction((sp) => sp.update(leads).set({ dedupeKey }).where(eq(leads.id, leadId)));
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("Another open lead in this process already has this number / email");
    throw err;
  }
}

export const LeadIdsInput = z.object({ leadIds: z.array(z.uuid()).min(1).max(200) });

export async function deleteLeads(ctx: SessionContext, input: z.infer<typeof LeadIdsInput>) {
  requirePermission(ctx, "leads", "D");
  const now = new Date();
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: leads.id, owner: leads.assignedTo, status: leads.status })
      .from(leads)
      .where(and(inArray(leads.id, input.leadIds), isNull(leads.deletedAt), leadScopeCondition(ctx)))
      .for("update");
    if (!rows.length) return { deleted: 0, skipped: input.leadIds.length };
    const ids = rows.map((r) => r.id);
    await tx.update(leads).set({ isActive: false, deletedAt: now, deletedBy: ctx.actor.userId, nextCallbackAt: null }).where(inArray(leads.id, ids));
    await tx.update(callbacks).set({ status: "cancelled" }).where(and(inArray(callbacks.leadId, ids), eq(callbacks.status, "pending")));
    await releaseCapacity(tx, rows, -1);
    await tx.insert(leadEvents).values(ids.map((leadId) => ({ leadId, type: "deleted" as const, actor: { kind: "user" as const, id: ctx.actor.userId, name: ctx.actor.name } })));
    await writeAudit(tx, ctx, { action: "leads.deleted", entity: "lead", entityId: ids[0]!, after: { count: ids.length, ids: ids.slice(0, 50) } });
    return { deleted: ids.length, skipped: input.leadIds.length - ids.length };
  });
}

export async function restoreLeads(ctx: SessionContext, input: z.infer<typeof LeadIdsInput>) {
  requirePermission(ctx, "leads", "D");
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: leads.id, owner: leads.assignedTo, status: leads.status })
      .from(leads)
      .where(and(inArray(leads.id, input.leadIds), isNotNull(leads.deletedAt), leadScopeCondition(ctx)))
      .for("update");
    const back: typeof rows = [];
    for (const r of rows) {
      try {
        // SAVEPOINT: an open lead may now hold the same dedupe key.
        await tx.transaction((sp) => sp.update(leads).set({ isActive: true, deletedAt: null, deletedBy: null }).where(eq(leads.id, r.id)));
        back.push(r);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    if (back.length) {
      await releaseCapacity(tx, back, +1);
      await tx.insert(leadEvents).values(back.map((r) => ({ leadId: r.id, type: "restored" as const, actor: { kind: "user" as const, id: ctx.actor.userId, name: ctx.actor.name } })));
      await writeAudit(tx, ctx, { action: "leads.restored", entity: "lead", entityId: back[0]!.id, after: { count: back.length } });
    }
    return { restored: back.length, skipped: input.leadIds.length - back.length };
  });
}

/** open_leads follows open, assigned leads leaving (-1) or returning (+1). */
async function releaseCapacity(tx: Tx, rows: { owner: string | null; status: string }[], sign: 1 | -1) {
  const per = new Map<string, number>();
  for (const r of rows) if (r.owner && r.status === "open") per.set(r.owner, (per.get(r.owner) ?? 0) + 1);
  for (const [uid, n] of per) await tx.update(users).set({ openLeads: sql`greatest(${users.openLeads} + ${sign * n}, 0)` }).where(eq(users.id, uid));
}
