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
import { contacts, customFieldDefinitions, leads, processes, users } from "@/lib/db/schema";
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

/** System-defined filters (checkboxes on Leads and in the console). */
export const FLAGS = [
  "mine",
  "unassigned",
  "assigned",
  "not_called",
  "touched",
  "callback_overdue",
  "callback_today",
  "has_callback",
  "no_callback",
  "re_enquired",
  "stale_7d",
  "has_email",
  "no_email",
  "no_phone",
  "converted_today",
] as const;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use yyyy-mm-dd").optional();
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
  /** Column filters. Dates are calendar days in the workspace timezone (inclusive). */
  campaign: csv,
  outcome: csv, // last outcome labels
  city: z.string().max(60).optional(), // contains
  attempts_min: z.coerce.number().int().min(0).max(1000).optional(),
  attempts_max: z.coerce.number().int().min(0).max(1000).optional(),
  created_from: DATE,
  created_to: DATE,
  activity_from: DATE,
  activity_to: DATE,
  callback_from: DATE,
  callback_to: DATE,
  sort: z.enum(SORTS).default("newest"),
  // The UI offers 25 / 50 / 100; the API accepts 1–100.
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Next page: rows after this cursor. */
  cursor: z.string().max(300).optional(),
  /** Previous page: rows before this cursor (keyset backwards — still no OFFSET). */
  before: z.string().max(300).optional(),
});
/**
 * Custom-field filters ride alongside as `cf_<key>` params (one per field):
 *   text     cf_city=~pune            contains
 *   dropdown cf_course==MBA|BBA        any of
 *   number   cf_budget=n:5..20         from..to (either side may be empty)
 *   date     cf_visit=d:2026-10-01..2026-10-31
 *   yes/no   cf_site_visit=b:yes
 */
export type CustomFilterKey = `cf_${string}`;
export type LeadQueryInput = z.input<typeof LeadQuery> & Partial<Record<CustomFilterKey, string>>;
type Query = z.output<typeof LeadQuery>;

export type CustomFilter =
  | { key: string; op: "contains"; value: string }
  | { key: string; op: "in"; values: string[] }
  | { key: string; op: "num"; min?: number; max?: number }
  | { key: string; op: "date"; from?: string; to?: string }
  | { key: string; op: "bool"; value: boolean };

const CF_KEY = /^cf_([a-z0-9_]{1,40})$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `cf_*` params (unknown/garbled ones are ignored, never trusted into SQL as text). */
export function parseCustomFilters(raw: Record<string, unknown>): CustomFilter[] {
  const out: CustomFilter[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const key = CF_KEY.exec(k)?.[1];
    if (!key || typeof v !== "string" || !v || v.length > 300) continue;
    if (v.startsWith("~")) out.push({ key, op: "contains", value: v.slice(1).trim() });
    else if (v.startsWith("=")) out.push({ key, op: "in", values: v.slice(1).split("|").map((x) => x.trim()).filter(Boolean).slice(0, 30) });
    else if (v.startsWith("n:")) {
      const [a, b] = v.slice(2).split("..");
      const n = (x?: string) => (x !== undefined && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : undefined);
      out.push({ key, op: "num", min: n(a), max: n(b) });
    } else if (v.startsWith("d:")) {
      const [a, b] = v.slice(2).split("..");
      out.push({ key, op: "date", from: a && ISO_DAY.test(a) ? a : undefined, to: b && ISO_DAY.test(b) ? b : undefined });
    } else if (v.startsWith("b:")) out.push({ key, op: "bool", value: /^(yes|true|1)$/i.test(v.slice(2)) });
  }
  return out;
}

function customCondition(f: CustomFilter): SQL | undefined {
  const val = sql`(${leads.custom} ->> ${f.key})`;
  switch (f.op) {
    case "contains":
      return f.value ? sql`${val} ilike ${`%${escapeLike(f.value)}%`}` : undefined;
    case "in":
      return f.values.length ? inArray(val, f.values) : undefined;
    case "num": {
      // Only numeric-looking values are compared (a text value never breaks the query).
      const num = sql`(case when ${val} ~ '^-?[0-9]+([.][0-9]+)?$' then (${val})::numeric end)`;
      return and(f.min !== undefined ? sql`${num} >= ${f.min}` : undefined, f.max !== undefined ? sql`${num} <= ${f.max}` : undefined, sql`${num} is not null`);
    }
    case "date": {
      // Dates are stored as ISO strings; compare the yyyy-mm-dd prefix.
      const day = sql`left(${val}, 10)`;
      return and(f.from ? sql`${day} >= ${f.from}` : undefined, f.to ? sql`${day} <= ${f.to}` : undefined, sql`${val} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`);
    }
    case "bool":
      return f.value ? sql`lower(${val}) in ('true','yes','1')` : sql`(${val} is null or lower(${val}) in ('false','no','0'))`;
  }
}

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

/** Day boundary in the workspace timezone for a yyyy-mm-dd (start of that day). */
const dayAt = (d: string, tz: string) => sql`((${d})::date::timestamp at time zone ${tz})`;
const dayRange = (col: SQL, from: string | undefined, to: string | undefined, tz: string) =>
  and(from ? sql`${col} >= ${dayAt(from, tz)}` : undefined, to ? sql`${col} < ${dayAt(to, tz)} + interval '1 day'` : undefined);

function filterConditions(ctx: SessionContext, f: Query, custom: CustomFilter[] = []): (SQL | undefined)[] {
  const tz = ctx.timezone;
  const owners = f.owner.filter((o) => o !== "none");
  const has = (x: (typeof FLAGS)[number]) => f.flag.includes(x);
  return [
    f.status === "all" || f.status === "deleted" ? undefined : eq(leads.status, f.status),
    f.stage.length ? inArray(leads.stage, f.stage) : undefined,
    f.source.length ? inArray(sql`${leads.source}->>'kind'`, f.source) : undefined,
    f.process.length ? inArray(leads.processId, f.process) : undefined,
    f.owner.length ? or(owners.length ? inArray(leads.assignedTo, owners) : undefined, f.owner.includes("none") ? isNull(leads.assignedTo) : undefined) : undefined,
    // System filters
    has("unassigned") ? isNull(leads.assignedTo) : undefined,
    has("assigned") ? isNotNull(leads.assignedTo) : undefined,
    has("mine") ? eq(leads.assignedTo, ctx.actor.userId) : undefined,
    has("not_called") ? eq(leads.attempts, 0) : undefined,
    has("touched") ? sql`${leads.attempts} > 0` : undefined,
    has("callback_overdue") ? pendingCallback(sql`c.due_at < now()`) : undefined,
    has("callback_today") ? pendingCallback(sql`c.due_at >= ${dayStart(tz)} and c.due_at < ${dayStart(tz)} + interval '1 day'`) : undefined,
    has("has_callback") ? pendingCallback(sql`true`) : undefined,
    has("no_callback") ? sql`not ${pendingCallback(sql`true`)}` : undefined,
    has("re_enquired") ? sql`${leads.lastEnquiryAt} > ${leads.createdAt} + interval '1 minute'` : undefined,
    has("stale_7d") ? sql`coalesce(${leads.lastInteractionAt}, ${leads.createdAt}) < now() - interval '7 days'` : undefined,
    has("has_email") ? sql`${contacts.email} is not null and ${contacts.email} <> ''` : undefined,
    has("no_email") ? sql`(${contacts.email} is null or ${contacts.email} = '')` : undefined,
    has("no_phone") ? isNull(contacts.phoneE164) : undefined,
    has("converted_today") ? and(eq(leads.status, "won"), gte(leads.convertedAt, sql`${dayStart(tz)}`)) : undefined,
    // Created presets + range
    f.created === "today" ? gte(leads.createdAt, sql`${dayStart(tz)}`) : undefined,
    f.created === "7d" ? gte(leads.createdAt, sql`now() - interval '7 days'`) : undefined,
    f.created === "30d" ? gte(leads.createdAt, sql`now() - interval '30 days'`) : undefined,
    dayRange(sql`${leads.createdAt}`, f.created_from, f.created_to, tz),
    dayRange(sql`coalesce(${leads.lastInteractionAt}, ${leads.createdAt})`, f.activity_from, f.activity_to, tz),
    dayRange(sql`${leads.nextCallbackAt}`, f.callback_from, f.callback_to, tz),
    // Column filters
    f.campaign.length ? inArray(sql`${leads.source}->>'campaign'`, f.campaign) : undefined,
    f.outcome.length ? inArray(sql`${leads.lastDisposition}->>'label'`, f.outcome) : undefined,
    f.city ? sql`${leads.custom}->>'city' ilike ${`%${escapeLike(f.city)}%`}` : undefined,
    f.attempts_min !== undefined ? gte(leads.attempts, f.attempts_min) : undefined,
    f.attempts_max !== undefined ? sql`${leads.attempts} <= ${f.attempts_max}` : undefined,
    ...custom.map(customCondition),
    searchCondition(f.q),
  ];
}

/**
 * The WHERE for a lead filter — shared by the Leads list, the console queue,
 * REST and GraphQL so a filter behaves identically everywhere. Excludes
 * deleted leads (except the Recycle bin view) and applies the role's scope.
 */
export function leadFilterWhere(ctx: SessionContext, raw: LeadQueryInput): SQL | undefined {
  const f = LeadQuery.parse(raw);
  const bin = f.status === "deleted";
  const alive = bin ? (can(ctx.actor.role, "leads", "D") ? isNotNull(leads.deletedAt) : sql`false`) : and(eq(leads.isActive, true), isNull(leads.deletedAt));
  return and(leadScopeCondition(ctx), alive, ...filterConditions(ctx, f, parseCustomFilters(raw as Record<string, unknown>)));
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
  // Recycle bin only for roles that may delete; everyone else sees live leads only (inside leadFilterWhere).
  const where = leadFilterWhere(ctx, input);
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
    const campaigns = await tx
      .select({ v: sql<string>`${leads.source}->>'campaign'`, n: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(scope, sql`${leads.source}->>'campaign' is not null`))
      .groupBy(sql`1`)
      .orderBy(desc(sql`2`))
      .limit(50);
    const outcomes = await tx
      .select({ v: sql<string>`${leads.lastDisposition}->>'label'`, n: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(scope, sql`${leads.lastDisposition} is not null`))
      .groupBy(sql`1`)
      .orderBy(desc(sql`2`))
      .limit(50);
    // Custom fields defined for leads (workspace-wide + per process), one entry per key.
    const defs = await tx
      .select({ key: customFieldDefinitions.key, label: customFieldDefinitions.label, type: customFieldDefinitions.type, options: customFieldDefinitions.options })
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.isActive, true), eq(customFieldDefinitions.entity, "lead")))
      .orderBy(customFieldDefinitions.sortOrder, customFieldDefinitions.label);
    const fields = [...new Map(defs.map((d) => [d.key, d])).values()];
    return { stages, sources, owners, processes: procs, campaigns, outcomes, fields };
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

