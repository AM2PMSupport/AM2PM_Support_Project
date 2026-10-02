/**
 * Create a lead, or merge it into the existing active lead (DESIGN.md §3.3).
 *
 * The partial unique index `leads_dedupe_active` on (tenant_id, process_id,
 * dedupe_key) WHERE is_active is the single source of truth for duplicates.
 * We NEVER "find then insert" (RULE.md §2.1): two imports racing each other
 * would both see "no lead" and both insert. Instead:
 *
 *   INSERT ... ON CONFLICT (tenant_id, process_id, dedupe_key) WHERE is_active DO NOTHING RETURNING id
 *
 * No row back = a duplicate → merge (bump last_enquiry_at, log "merged").
 * Created → lead_events(created) + outbox(lead.created) in the SAME
 * transaction, then an "assign-lead" job is queued after commit — unless
 * the caller assigns inline (bulk imports: one QStash message per chunk,
 * not per lead).
 */
import { and, eq, or, sql } from "drizzle-orm";
import { contacts, leadEvents, leads, type LeadSourceInfo, type Process } from "@/lib/db/schema";
import { withTenant, type Tx } from "@/lib/db/tenant";
import { publishOutboxSafely, writeOutbox } from "@/lib/events/outbox";
import type { NormalisedLead } from "@/lib/leads/normalise";
import { enqueue } from "@/lib/queue/qstash";
import { notify } from "@/lib/notifications";
import type { TenantContext } from "@/lib/tenancy/context";

export type CreateLeadResult = { outcome: "created"; leadId: string } | { outcome: "merged"; leadId: string };

/** The value a process dedupes on, or null when the lead lacks it. */
export function dedupeValue(process: Pick<Process, "dedupeField">, lead: NormalisedLead): string | null {
  switch (process.dedupeField) {
    case "phoneKey":
      return lead.phoneKey ?? null;
    case "email":
      return lead.email ?? null;
    default: {
      const v = lead.custom[process.dedupeField];
      return v === undefined || v === null || v === "" ? null : String(v).trim().toLowerCase();
    }
  }
}

/** Find the contact by phone key or email, else create it. Contacts are shared across processes. */
async function upsertContact(tx: Tx, lead: NormalisedLead): Promise<string> {
  const conds = [
    lead.phoneKey ? eq(contacts.phoneKey, lead.phoneKey) : undefined,
    lead.email ? eq(contacts.email, lead.email) : undefined,
  ].filter((c) => c !== undefined);
  if (conds.length) {
    const [found] = await tx.select({ id: contacts.id }).from(contacts).where(or(...conds)).limit(1);
    if (found) return found.id;
  }
  const [created] = await tx
    .insert(contacts)
    .values({ name: lead.name, phoneE164: lead.phoneE164, phoneKey: lead.phoneKey, email: lead.email })
    .returning({ id: contacts.id });
  return created!.id;
}

export async function createOrMergeLead(
  ctx: TenantContext,
  process: Pick<Process, "id" | "stages" | "dedupeField">,
  lead: NormalisedLead,
  source: LeadSourceInfo,
  opts: { queueAssign?: boolean } = {},
): Promise<CreateLeadResult> {
  const value = dedupeValue(process, lead);
  // No dedupe value (e.g. email-only lead on a phone-deduped process): never collides.
  const dedupeKey = value ?? `nokey:${crypto.randomUUID()}`;
  const now = new Date();

  const result = await withTenant(ctx, async (tx) => {
    const contactId = await upsertContact(tx, lead);

    const [inserted] = await tx
      .insert(leads)
      .values({
        processId: process.id,
        contactId,
        source,
        importSourceId: source.sourceId ?? null,
        stage: process.stages[0] ?? "New",
        dedupeKey,
        lastEnquiryAt: now,
        custom: lead.custom,
      })
      .onConflictDoNothing({ target: [leads.tenantId, leads.processId, leads.dedupeKey], where: sql`${leads.isActive}` })
      .returning({ id: leads.id });

    if (inserted) {
      await tx.insert(leadEvents).values({ leadId: inserted.id, type: "created", actor: { kind: "source", name: source.kind }, after: { source } });
      const outboxId = await writeOutbox(tx, "lead.created", inserted.id, { leadId: inserted.id, processId: process.id, source });
      return { outcome: "created" as const, leadId: inserted.id, outboxId };
    }

    // Duplicate: record the re-enquiry on the existing active lead.
    const [existing] = await tx
      .update(leads)
      .set({ lastEnquiryAt: now })
      .where(and(eq(leads.processId, process.id), eq(leads.dedupeKey, dedupeKey), eq(leads.isActive, true)))
      .returning({ id: leads.id, assignedTo: leads.assignedTo });
    if (!existing) throw new Error("dedupe conflict but no active lead found"); // retried by the job
    await tx.insert(leadEvents).values({ leadId: existing.id, type: "merged", actor: { kind: "source", name: source.kind }, after: { source } });
    if (existing.assignedTo) {
      await notify(tx, [existing.assignedTo], {
        kind: "lead_merged",
        title: `${lead.name ?? "A lead"} enquired again`,
        body: `New enquiry from ${source.kind.replace(/_/g, " ")} — call while they're interested`,
        link: `/console?lead=${existing.id}`,
      });
    }
    return { outcome: "merged" as const, leadId: existing.id, outboxId: undefined };
  });

  if (result.outcome === "created") {
    await publishOutboxSafely(ctx, [result.outboxId]);
    if (opts.queueAssign !== false) {
      await enqueue("assign-lead", { tenantId: ctx.tenantId, leadId: result.leadId }, { deduplicationId: `assign:${result.leadId}` });
    }
  }
  return { outcome: result.outcome, leadId: result.leadId };
}
