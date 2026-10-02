/**
 * Calls log — every call in the viewer's scope with its time, result,
 * durations and recording (Calls screen + console timeline).
 *
 * Scope (RULE.md §1 + DESIGN §7): agents see THEIR calls; supervisors,
 * managers, coordinators and clients see calls of their processes; admins
 * the whole workspace — always inside RLS. Keyset paging on (started_at, id)
 * over the partial index interactions_calls / interactions_agent_calls.
 * Phone numbers are masked per role exactly like leads.
 */
import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { contacts, interactions, leads, processes, userProcesses } from "@/lib/db/schema";
import { withTenantRead } from "@/lib/db/tenant";
import { leadScope, requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { displayPhone } from "@/lib/agent/queue";

export const CallQuery = z.object({
  q: z.string().max(60).optional(), // lead name or phone digits
  direction: z.enum(["inbound", "outbound"]).optional(),
  result: z.enum(["connected", "not_connected", "missed"]).optional(),
  agent: z.uuid().optional(),
  recording: z.enum(["yes"]).optional(),
  range: z.enum(["today", "7d", "30d", "all"]).default("7d"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(100).optional(),
});
export type CallQueryInput = z.input<typeof CallQuery>;

export interface CallRow {
  id: string;
  startedAt: string;
  direction: "inbound" | "outbound";
  status: string;
  durationSec: number | null;
  talkSec: number | null;
  hasRecording: boolean;
  leadId: string | null;
  leadName: string | null;
  customer: string;
  agentName: string | null;
  processName: string | null;
  outcome: string | null;
  hangupBy: string | null;
}

const CONNECTED = ["completed", "answered"];

/** Which calls this viewer may see (also used by the recording route). */
export function callScope(ctx: SessionContext): SQL | undefined {
  switch (leadScope(ctx.actor.role)) {
    case "tenant":
      return undefined;
    case "own":
      return eq(interactions.agentId, ctx.actor.userId);
    case "process":
      return inArray(interactions.processId, sql`(select ${userProcesses.processId} from ${userProcesses} where ${userProcesses.userId} = ${ctx.actor.userId})`);
    default:
      return sql`false`;
  }
}

export async function listCalls(ctx: SessionContext, input: CallQueryInput = {}): Promise<{ items: CallRow[]; nextCursor: string | null; total: number }> {
  requirePermission(ctx, "interactions", "V");
  const f = CallQuery.parse(input);
  const dayStart = sql`(date_trunc('day', now() at time zone ${ctx.timezone}) at time zone ${ctx.timezone})`;
  const digits = (f.q ?? "").replace(/\D/g, "");
  const where = and(
    eq(interactions.type, "call"),
    callScope(ctx),
    f.direction ? eq(interactions.direction, f.direction) : undefined,
    f.result === "connected" ? inArray(interactions.status, CONNECTED) : undefined,
    f.result === "missed" ? eq(interactions.status, "missed") : undefined,
    f.result === "not_connected" ? sql`${interactions.status} not in ('completed','answered','missed')` : undefined,
    f.agent ? eq(interactions.agentId, f.agent) : undefined,
    f.recording ? or(isNotNull(interactions.recordingKey), isNotNull(interactions.recordingUrl)) : undefined,
    f.range === "today" ? gte(interactions.startedAt, sql`${dayStart}`) : f.range === "7d" ? gte(interactions.startedAt, sql`now() - interval '7 days'`) : f.range === "30d" ? gte(interactions.startedAt, sql`now() - interval '30 days'`) : undefined,
    f.q
      ? digits.length >= 3
        ? sql`${interactions.customerNumber} like ${`%${digits}%`}`
        : sql`${contacts.name} ilike ${`%${f.q.replace(/[%_\\]/g, "\\$&")}%`}`
      : undefined,
  );
  const [cAt, cId] = (f.cursor ?? "").split("|");
  const after = cAt && cId ? or(lt(interactions.startedAt, new Date(cAt)), and(eq(interactions.startedAt, new Date(cAt)), lt(interactions.id, cId))) : undefined;

  const rowsQ = withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: interactions.id,
        startedAt: interactions.startedAt,
        direction: interactions.direction,
        status: interactions.status,
        durationSec: interactions.durationSec,
        talkSec: interactions.talkSec,
        recordingKey: interactions.recordingKey,
        recordingUrl: interactions.recordingUrl,
        leadId: interactions.leadId,
        leadName: contacts.name,
        customer: interactions.customerNumber,
        agentName: interactions.agentName,
        processName: processes.name,
        disposition: interactions.disposition,
        hangupBy: interactions.hangupBy,
      })
      .from(interactions)
      .leftJoin(leads, eq(leads.id, interactions.leadId))
      .leftJoin(contacts, eq(contacts.id, leads.contactId))
      .leftJoin(processes, eq(processes.id, interactions.processId))
      .where(and(where, after))
      .orderBy(desc(interactions.startedAt), desc(interactions.id))
      .limit(f.limit + 1),
  );
  const totalQ = withTenantRead(ctx, async (tx) => {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(interactions)
      .leftJoin(leads, eq(leads.id, interactions.leadId))
      .leftJoin(contacts, eq(contacts.id, leads.contactId))
      .where(where);
    return r?.n ?? 0;
  });
  const [rows, total] = await Promise.all([rowsQ, totalQ]);
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      direction: r.direction,
      status: r.status,
      durationSec: r.durationSec,
      talkSec: r.talkSec,
      hasRecording: !!(r.recordingKey || r.recordingUrl),
      leadId: r.leadId,
      leadName: r.leadName,
      customer: displayPhone(ctx.actor.role, r.customer),
      agentName: r.agentName,
      processName: r.processName,
      outcome: r.disposition?.label ?? null,
      hangupBy: r.hangupBy,
    })),
    nextCursor: rows.length > f.limit && last ? `${last.startedAt.toISOString()}|${last.id}` : null,
    total,
  };
}

/** Totals for the header strip (same filters, no paging). */
export async function callTotals(ctx: SessionContext, input: CallQueryInput = {}) {
  requirePermission(ctx, "interactions", "V");
  const f = CallQuery.parse(input);
  const dayStart = sql`(date_trunc('day', now() at time zone ${ctx.timezone}) at time zone ${ctx.timezone})`;
  const [r] = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        calls: sql<number>`count(*)::int`,
        connected: sql<number>`count(*) filter (where ${interactions.status} in ('completed','answered'))::int`,
        talkSec: sql<number>`coalesce(sum(${interactions.talkSec}), 0)::int`,
        recordings: sql<number>`count(*) filter (where ${interactions.recordingKey} is not null or ${interactions.recordingUrl} is not null)::int`,
      })
      .from(interactions)
      .where(
        and(
          eq(interactions.type, "call"),
          callScope(ctx),
          f.range === "today" ? gte(interactions.startedAt, sql`${dayStart}`) : f.range === "7d" ? gte(interactions.startedAt, sql`now() - interval '7 days'`) : f.range === "30d" ? gte(interactions.startedAt, sql`now() - interval '30 days'`) : undefined,
        ),
      ),
  );
  return r ?? { calls: 0, connected: 0, talkSec: 0, recordings: 0 };
}
