/**
 * Leads list (Zoho-style): quick search, system filters, sort, keyset
 * paging and a total — all inside the role's lead scope under RLS, on a
 * read replica (withTenantRead, least connections). T1.47 + Leads screen.
 *
 * `q` is classified exactly like searchContacts (lib/leads/search-classify.ts)
 * so each search hits its index. Paging is KEYSET on (sort value, id) —
 * never OFFSET (RULE.md §2.7); the cursor carries the last row's sort value.
 * The query input is the screen's URL params, so a saved filter is just
 * those params (lib/leads/views.ts).
 */
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { contacts, leads, processes, users } from "@/lib/db/schema";
import { withTenantRead } from "@/lib/db/tenant";
import type { SessionContext } from "@/lib/auth/session";
import { leadScopeCondition } from "@/lib/leads/scope";
import { can } from "@/lib/auth/rbac";
import { classifyQuery, escapeLike } from "@/lib/leads/search-classify";
import { displayPhone } from "@/lib/agent/queue";

export interface LeadRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  processId: string;
  processName: string;
  source: string;
  campaign: string | null;
  stage: string;
  status: string;
  ownerId: string | null;
  owner: string | null;
  lastDisposition: string | null;
  attempts: number;
  nextCallbackAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  city: string | null;
  deletedAt: string | null;
}

export const FLAGS = ["unassigned", "not_called", "callback_overdue", "callback_today", "re_enquired", "mine"] as const;
export const SORTS = ["newest", "oldest", "name", "callback", "activity"] as const;
const csv = z.string().max(2000).optional().transform((v) => (v ? v.split(",").filter(Boolean).slice(0, 50) : []));

/** The Leads screen's URL params — also the shape of a saved filter. */
export const LeadQuery = z.object({
  q: z.string().max(100).optional(),
  /** "deleted" = Recycle bin (roles with leads D only). */
  status: z.enum(["open", "won", "lost", "dnc", "all", "deleted"]).default("open"),
  stage: csv,
  source: csv,
  owner: csv, // user ids, or "none"
  process: csv,
  flag: csv.transform((f) => f.filter((x): x is (typeof FLAGS)[number] => (FLAGS as readonly string[]).includes(x))),
  created: z.enum(["today", "7d", "30d"]).optional(),
  sort: z.enum(SORTS).default("newest"),
  // The UI offers 25 / 50 / 100; the API accepts 1–100.
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Next page: rows after this cursor. */
  cursor: z.string().max(300).optional(),
  /** Previous page: rows before this cursor (keyset backwards — still no OFFSET). */
  before: z.string().max(300).optional(),
});
export type LeadQueryInput = z.input<typeof LeadQuery>;
type Query = z.output<typeof LeadQuery>;

function searchCondition(q: string | undefined): SQL | undefined {
  const c = q ? classifyQuery(q) : null;
  if (!c) return undefined;
  const pattern = `%${escapeLike(c.value)}%`;
  switch (c.kind) {
    case "email":
      return ilike(contacts.email, pattern);
    case "phone_exact":
      return eq(contacts.phoneKey, c.value);
    case "phone_partial":
      return ilike(contacts.phoneKey, pattern);
    case "name":
      return or(ilike(contacts.name, pattern), ilike(contacts.email, pattern));
  }
}

/** Start of "today" in the workspace timezone, as SQL. */
const dayStart = (tz: string) => sql`(date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`;
const pendingCallback = (extra: SQL) => sql`exists (select 1 from callbacks c where c.lead_id = ${leads.id} and c.status = 'pending' and ${extra})`;

function filterConditions(ctx: SessionContext, f: Query): (SQL | undefined)[] {
  const tz = ctx.timezone;
  const owners = f.owner.filter((o) => o !== "none");
  return [
    f.status === "all" || f.status === "deleted" ? undefined : eq(leads.status, f.status),
    f.stage.length ? inArray(leads.stage, f.stage) : undefined,
    f.source.length ? inArray(sql`${leads.source}->>'kind'`, f.source) : undefined,
    f.process.length ? inArray(leads.processId, f.process) : undefined,
    f.owner.length ? or(owners.length ? inArray(leads.assignedTo, owners) : undefined, f.owner.includes("none") ? isNull(leads.assignedTo) : undefined) : undefined,
    f.flag.includes("unassigned") ? isNull(leads.assignedTo) : undefined,
    f.flag.includes("mine") ? eq(leads.assignedTo, ctx.actor.userId) : undefined,
    f.flag.includes("not_called") ? eq(leads.attempts, 0) : undefined,
    f.flag.includes("callback_overdue") ? pendingCallback(sql`c.due_at < now()`) : undefined,
    f.flag.includes("callback_today") ? pendingCallback(sql`c.due_at >= ${dayStart(tz)} and c.due_at < ${dayStart(tz)} + interval '1 day'`) : undefined,
    f.flag.includes("re_enquired") ? sql`${leads.lastEnquiryAt} > ${leads.createdAt} + interval '1 minute'` : undefined,
    f.created === "today" ? gte(leads.createdAt, sql`${dayStart(tz)}`) : undefined,
    f.created === "7d" ? gte(leads.createdAt, sql`now() - interval '7 days'`) : undefined,
    f.created === "30d" ? gte(leads.createdAt, sql`now() - interval '30 days'`) : undefined,
    searchCondition(f.q),
  ];
}

/** Sort expression + direction. Nulls are mapped to sentinels so the keyset comparison is total. */
function sortSpec(sort: Query["sort"]): { expr: SQL; dir: "asc" | "desc"; kind: "time" | "text" } {
  switch (sort) {
    case "oldest":
      return { expr: sql`${leads.createdAt}`, dir: "asc", kind: "time" };
    case "name":
      return { expr: sql`lower(coalesce(${contacts.name}, ''))`, dir: "asc", kind: "text" };
    case "callback":
      return { expr: sql`coalesce(${leads.nextCallbackAt}, 'infinity'::timestamptz)`, dir: "asc", kind: "time" };
    case "activity":
      return { expr: sql`coalesce(${leads.lastInteractionAt}, ${leads.createdAt})`, dir: "desc", kind: "time" };
    default:
      return { expr: sql`${leads.createdAt}`, dir: "desc", kind: "time" };
  }
}

function encodeCursor(v: unknown, id: string) {
  return Buffer.from(JSON.stringify([v instanceof Date ? v.toISOString() : v, id])).toString("base64url");
}
function decodeCursor(c: string | undefined): [string, string] | null {
  if (!c) return null;
  try {
    const [v, id] = JSON.parse(Buffer.from(c, "base64url").toString()) as [unknown, unknown];
    return typeof v === "string" && typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? [v, id] : null;
  } catch {
    return null;
  }
}

export async function listLeads(
  ctx: SessionContext,
  input: LeadQueryInput = {},
  opts: { withTotal?: boolean } = {},
): Promise<{ items: LeadRow[]; nextCursor: string | null; prevCursor: string | null; total: number }> {
  const f = LeadQuery.parse(input);
  const s = sortSpec(f.sort);
  const bin = f.status === "deleted";
  // Recycle bin only for roles that may delete; everyone else sees live leads only.
  const alive = bin ? (can(ctx.actor.role, "leads", "D") ? isNotNull(leads.deletedAt) : sql`false`) : and(eq(leads.isActive, true), isNull(leads.deletedAt));
  const where = and(leadScopeCondition(ctx), alive, ...filterConditions(ctx, f));
  // Going back = walk the keyset in the opposite direction, then flip the page.
  const back = !!f.before && !f.cursor;
  const cur = decodeCursor(back ? f.before : f.cursor);
  const dir = back ? (s.dir === "asc" ? "desc" : "asc") : s.dir;
  const curVal = cur ? (s.kind === "time" ? sql`${cur[0]}::timestamptz` : sql`${cur[0]}`) : null;
  // Row-value comparison: (sortValue, id) strictly after the cursor in the walking direction.
  const keyset = cur ? (dir === "asc" ? sql`(${s.expr}, ${leads.id}) > (${curVal}, ${cur[1]}::uuid)` : sql`(${s.expr}, ${leads.id}) < (${curVal}, ${cur[1]}::uuid)`) : undefined;
  const order = dir === "asc" ? [sql`${s.expr} asc`, sql`${leads.id} asc`] : [sql`${s.expr} desc`, sql`${leads.id} desc`];

  const rowsQ = withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: leads.id,
        name: contacts.name,
        phoneE164: contacts.phoneE164,
        email: contacts.email,
        processId: leads.processId,
        processName: processes.name,
        source: leads.source,
        stage: leads.stage,
        status: leads.status,
        ownerId: leads.assignedTo,
        owner: users.name,
        lastDisposition: leads.lastDisposition,
        attempts: leads.attempts,
        nextCallbackAt: leads.nextCallbackAt,
        lastActivityAt: leads.lastInteractionAt,
        createdAt: leads.createdAt,
        custom: leads.custom,
        deletedAt: leads.deletedAt,
        sortValue: sql<string | Date>`${s.expr}`,
      })
      .from(leads)
      .innerJoin(contacts, eq(contacts.id, leads.contactId))
      .innerJoin(processes, eq(processes.id, leads.processId))
      .leftJoin(users, eq(users.id, leads.assignedTo))
      .where(and(where, keyset))
      .orderBy(...order)
      .limit(f.limit + 1),
  );
  // Total for "1–50 of 1,234": same filters, no paging (parallel, own transaction).
  // Skipped when the caller doesn't need it (GraphQL without `total`) → -1.
  const totalQ = opts.withTotal === false ? Promise.resolve(-1) : withTenantRead(ctx, async (tx) => {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(leads).innerJoin(contacts, eq(contacts.id, leads.contactId)).where(where);
    return r?.n ?? 0;
  });
  const [rows, total] = await Promise.all([rowsQ, totalQ]);

  const more = rows.length > f.limit;
  const page = back ? rows.slice(0, f.limit).reverse() : rows.slice(0, f.limit);
  const first = page[0];
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      name: r.name ?? "Unknown caller",
      phone: displayPhone(ctx.actor.role, r.phoneE164),
      email: r.email,
      processId: r.processId,
      processName: r.processName,
      source: r.source.kind,
      campaign: r.source.campaign ?? null,
      stage: r.stage,
      status: r.status,
      ownerId: r.ownerId,
      owner: r.owner,
      lastDisposition: r.lastDisposition?.label ?? null,
      attempts: r.attempts,
      nextCallbackAt: r.nextCallbackAt ? r.nextCallbackAt.toISOString() : null,
      lastActivityAt: r.lastActivityAt ? r.lastActivityAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      city: typeof r.custom.city === "string" ? r.custom.city : null,
      deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    })),
    // Forward: next exists if we fetched an extra row; prev exists if we came from a cursor.
    // Backward: prev exists if there was an extra row; next always (we came from there).
    nextCursor: last && (back || more) ? encodeCursor(last.sortValue, last.id) : null,
    prevCursor: first && (back ? more : !!f.cursor) ? encodeCursor(first.sortValue, first.id) : null,
    total,
  };
}

/** Options for the filter sidebar: stages, sources and owners in scope, with counts of open leads. */
export async function leadFilterOptions(ctx: SessionContext) {
  const scope = and(leadScopeCondition(ctx), eq(leads.isActive, true), isNull(leads.deletedAt));
  return withTenantRead(ctx, async (tx) => {
    const [stages, sources, owners, procs] = [
      await tx.select({ v: leads.stage, n: sql<number>`count(*) filter (where ${leads.status} = 'open')::int` }).from(leads).where(scope).groupBy(leads.stage).orderBy(desc(sql`2`)),
      await tx.select({ v: sql<string>`${leads.source}->>'kind'`, n: sql<number>`count(*)::int` }).from(leads).where(scope).groupBy(sql`1`).orderBy(desc(sql`2`)),
      await tx
        .select({ id: users.id, name: users.name, n: sql<number>`count(${leads.id}) filter (where ${leads.status} = 'open')::int` })
        .from(users)
        .leftJoin(leads, and(eq(leads.assignedTo, users.id), scope))
        .where(and(eq(users.status, "active"), inArray(users.role, ["agent", "process_coordinator"])))
        .groupBy(users.id, users.name)
        .orderBy(users.name),
      await tx.select({ id: processes.id, name: processes.name, stages: processes.stages }).from(processes).where(eq(processes.status, "active")).orderBy(processes.name),
    ];
    return { stages, sources, owners, processes: procs };
  });
}

/** Rows for CSV export (same filters, capped). */
export async function exportLeads(ctx: SessionContext, input: LeadQueryInput, cap = 10_000): Promise<LeadRow[]> {
  const out: LeadRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await listLeads(ctx, { ...input, limit: 100, cursor });
    out.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && out.length < cap);
  return out.slice(0, cap);
}

