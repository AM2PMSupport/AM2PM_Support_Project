/**
 * The agent's queue and the lead workspace (T1.33, T1.34).
 *
 * Queue order (PRD FR-18): callbacks due now → missed inbound calls → fresh
 * leads (never attempted) → the rest by next callback. Visibility follows the
 * role's lead scope (lib/leads/scope.ts) inside RLS. Phone numbers are masked
 * for roles that may not see them (agents still call via click-to-call —
 * the server uses the real number).
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { contacts, leads, processes, users, type Interaction, type LeadEvent } from "@/lib/db/schema";
import { withTenant, type Tx } from "@/lib/db/tenant";
import { canSeeFullPhone } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { leadScopeCondition } from "@/lib/leads/scope";
import { maskPhone } from "@/lib/phone/phone";
import { notFound } from "@/lib/http/errors";

export interface QueueItem {
  id: string;
  name: string;
  phone: string;
  city: string | null;
  processName: string;
  source: string;
  campaign: string | null;
  stage: string;
  attempts: number;
  ageMin: number;
  callbackInMin: number | null;
  missedCall: boolean;
  lastDisposition: string | null;
}

export function displayPhone(role: SessionContext["actor"]["role"], e164: string | null): string {
  if (!e164) return "—";
  if (canSeeFullPhone(role)) {
    const d = e164.replace(/\D/g, "").slice(-10);
    return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
  }
  return `+91 ${maskPhone(e164.replace(/\D/g, "").slice(-10))}`;
}

function priority(i: QueueItem): number {
  if (i.callbackInMin !== null && i.callbackInMin <= 0) return 0;
  if (i.missedCall) return 1;
  if (i.attempts === 0) return 2;
  return 3;
}

export async function getQueue(ctx: SessionContext, limit = 150): Promise<QueueItem[]> {
  return withTenant(ctx, (tx) => queueIn(tx, ctx, limit));
}

async function queueIn(tx: Tx, ctx: SessionContext, limit = 150): Promise<QueueItem[]> {
  const now = Date.now();
  // One statement: the pending-callback facts come back as columns (one round trip, not two).
  const rows = await tx
    .select({
      lead: leads,
      contact: contacts,
      processName: processes.name,
      callbackDue: sql<Date | string | null>`(select min(c.due_at) from callbacks c where c.lead_id = ${leads.id} and c.status = 'pending')`,
      missedCall: sql<boolean>`exists (select 1 from callbacks c where c.lead_id = ${leads.id} and c.status = 'pending' and c.reason = 'missed_call')`,
    })
    .from(leads)
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .innerJoin(processes, eq(processes.id, leads.processId))
    .where(and(leadScopeCondition(ctx), eq(leads.status, "open"), eq(leads.isActive, true)))
    .orderBy(asc(leads.nextCallbackAt), desc(leads.createdAt))
    .limit(limit);
  const items: QueueItem[] = rows.map(({ lead, contact, processName, callbackDue, missedCall }) => {
    const due = callbackDue ? new Date(callbackDue) : null;
    return {
      id: lead.id,
      name: contact.name ?? "Unknown caller",
      phone: displayPhone(ctx.actor.role, contact.phoneE164),
      city: typeof lead.custom.city === "string" ? lead.custom.city : null,
      processName,
      source: lead.source.kind,
      campaign: lead.source.campaign ?? null,
      stage: lead.stage,
      attempts: lead.attempts,
      ageMin: Math.max(0, Math.round((now - lead.createdAt.getTime()) / 60000)),
      callbackInMin: due ? Math.round((due.getTime() - now) / 60000) : null,
      missedCall: !!missedCall,
      lastDisposition: lead.lastDisposition?.label ?? null,
    };
  });
  return items.sort((a, b) => priority(a) - priority(b) || (a.callbackInMin ?? 9e9) - (b.callbackInMin ?? 9e9) || a.ageMin - b.ageMin);
}

export interface TimelineEntry {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  at: string; // ISO
  by: string | null;
  tone: "teal" | "ember" | "moss" | "ink";
  /** Calls only: play via /api/v1/calls/{callId}/recording. */
  callId?: string;
  hasRecording?: boolean;
}

const EVENT_TITLE: Record<string, string> = {
  created: "Lead created",
  merged: "Re-enquired",
  assigned: "Assigned",
  reassigned: "Reassigned",
  stage_changed: "Stage changed",
  disposition_set: "Outcome saved",
  callback_set: "Callback scheduled",
  converted: "Converted",
  lost: "Closed as lost",
  restored: "Restored",
  edited: "Details edited",
  deleted: "Deleted",
};

/** Timestamps inside json_agg arrive as strings; normalise to ISO. */
const iso = (v: Date | string) => new Date(v).toISOString();

type EventJson = Pick<LeadEvent, "id" | "type" | "after" | "actor"> & { createdAt: string };
type CallJson = Pick<Interaction, "id" | "type" | "direction" | "status" | "durationSec" | "talkSec" | "notes" | "disposition" | "agentName"> & { startedAt: string; hasRecording: boolean };

export async function getLeadDetail(ctx: SessionContext, leadId: string) {
  return withTenant(ctx, (tx) => detailIn(tx, ctx, leadId));
}

/**
 * Console first paint: queue + the open lead in ONE transaction (one setup
 * round trip instead of two). `wanted` (from a notification link) wins when
 * it is in scope; otherwise the top of the queue.
 */
export async function getConsole(ctx: SessionContext, wanted: string | null) {
  return withTenant(ctx, async (tx) => {
    const queue = await queueIn(tx, ctx);
    // notFound is thrown in JS (no SQL error), so catching it keeps the transaction usable.
    const linked = wanted ? await detailIn(tx, ctx, wanted).catch(() => null) : null;
    const lead = linked ?? (queue[0] ? await detailIn(tx, ctx, queue[0].id) : null);
    return { queue, lead };
  });
}

async function detailIn(tx: Tx, ctx: SessionContext, leadId: string) {
  // ONE statement for the whole panel (was 7 sequential queries ≈ 7 round
  // trips). Lists come back as json_agg columns; RLS applies to every
  // subquery because they run in this tenant transaction.
  const [row] = await tx
    .select({
      lead: leads,
      contact: contacts,
      process: processes,
      owner: users.name,
      nextCallbackAt: sql<Date | string | null>`(select min(c.due_at) from callbacks c where c.lead_id = ${leads.id} and c.status = 'pending')`,
      outcomes: sql<{ id: string; label: string; category: string }[]>`(
        select coalesce(json_agg(json_build_object('id', d.id, 'label', d.label, 'category', d.category) order by d.sort_order), '[]'::json)
        from dispositions d where d.is_active and (d.process_id = ${processes.id} or d.process_id is null))`,
      fields: sql<{ key: string; label: string; type: string; options: string[]; required: boolean }[]>`(
        select coalesce(json_agg(json_build_object('key', f.key, 'label', f.label, 'type', f.type, 'options', f.options, 'required', f.required) order by f.sort_order, f.label), '[]'::json)
        from custom_field_definitions f where f.is_active and f.entity = 'lead' and (f.process_id = ${processes.id} or f.process_id is null))`,
      events: sql<EventJson[]>`(
        select coalesce(json_agg(json_build_object('id', e.id, 'type', e.type, 'after', e.after, 'actor', e.actor, 'createdAt', e.created_at) order by e.created_at desc), '[]'::json)
        from (select * from lead_events where lead_id = ${leads.id} order by created_at desc limit 40) e)`,
      calls: sql<CallJson[]>`(
        select coalesce(json_agg(json_build_object('id', i.id, 'type', i.type, 'direction', i.direction, 'status', i.status, 'durationSec', i.duration_sec,
          'notes', i.notes, 'disposition', i.disposition, 'agentName', i.agent_name, 'startedAt', i.started_at,
          'talkSec', i.talk_sec, 'hasRecording', (i.recording_key is not null or i.recording_url is not null)) order by i.started_at desc), '[]'::json)
        from (select * from interactions where lead_id = ${leads.id} order by started_at desc limit 40) i)`,
    })
    .from(leads)
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .innerJoin(processes, eq(processes.id, leads.processId))
    .leftJoin(users, eq(users.id, leads.assignedTo))
    .where(and(eq(leads.id, leadId), leadScopeCondition(ctx)));
  if (!row) throw notFound("Lead not found");
  const { lead, contact, process, outcomes, fields, events, calls } = row;

  const timeline: TimelineEntry[] = [
    ...events.map((e) => ({
      id: `e-${e.id}`,
      kind: e.type,
      title:
        e.type === "disposition_set" && typeof e.after?.label === "string"
          ? `Outcome: ${e.after.label}`
          : e.type === "stage_changed" && typeof e.after?.stage === "string"
            ? `Stage → ${e.after.stage}`
            : (EVENT_TITLE[e.type] ?? e.type),
      detail: typeof e.after?.note === "string" ? e.after.note : e.type === "created" || e.type === "merged" ? `Source: ${String((e.after?.source as { kind?: string } | undefined)?.kind ?? "")}` : null,
      at: iso(e.createdAt),
      by: e.actor.name ?? null,
      tone: (e.type === "converted" ? "moss" : e.type === "lost" ? "ember" : "ink") as TimelineEntry["tone"],
    })),
    ...calls.map((c) => ({
      id: `c-${c.id}`,
      kind: "call",
      title: `${c.direction === "inbound" ? "Inbound" : "Outbound"} ${c.type} · ${c.status.replace(/_/g, " ")}${c.durationSec ? ` · ${Math.floor(c.durationSec / 60)}m ${c.durationSec % 60}s` : ""}${c.talkSec ? ` (talk ${Math.floor(c.talkSec / 60)}m ${c.talkSec % 60}s)` : ""}`,
      callId: c.type === "call" ? c.id : undefined,
      hasRecording: !!c.hasRecording,
      detail: c.notes ?? (c.disposition ? `Outcome: ${c.disposition.label}` : null),
      at: iso(c.startedAt),
      by: c.agentName,
      tone: (c.status === "missed" || c.status === "failed" ? "ember" : c.status === "completed" || c.status === "answered" ? "teal" : "ink") as TimelineEntry["tone"],
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    id: lead.id,
    name: contact.name ?? "Unknown caller",
    phone: displayPhone(ctx.actor.role, contact.phoneE164),
    /** True when `phone` is the full number (role may see and edit it). */
    phoneFull: canSeeFullPhone(ctx.actor.role),
    email: contact.email,
    processId: process.id,
    ownerId: lead.assignedTo,
    dnc: contact.dnc || lead.status === "dnc",
    status: lead.status,
    stage: lead.stage,
    stages: process.stages,
    wonStage: process.wonStage,
    processName: process.name,
    source: lead.source.kind,
    campaign: lead.source.campaign ?? null,
    attempts: lead.attempts,
    custom: lead.custom,
    fields,
    outcomes,
    owner: row.owner ?? null,
    nextCallbackAt: row.nextCallbackAt ? iso(row.nextCallbackAt) : null,
    lastDisposition: lead.lastDisposition?.label ?? null,
    createdAt: lead.createdAt.toISOString(),
    timeline,
  };
}

export type LeadDetail = Awaited<ReturnType<typeof getLeadDetail>>;
