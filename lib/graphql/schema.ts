/**
 * GraphQL API (POST /api/graphql) — the same data and actions as REST v1,
 * for clients that want exactly the fields they need in ONE round trip.
 *
 * Every resolver is a thin call into lib/* (the functions the screens and
 * REST use), so permissions, RLS, dedupe, events and audit are identical.
 * Auth = session cookie or `Authorization: Bearer am2pm_…` (lib/api/context.ts);
 * mutations need a write-scope key. `typeDefs` is mirrored verbatim in
 * API.md §6.2 — tests/api-docs.test.ts fails if they drift.
 */
import { GraphQLError, GraphQLScalarType, Kind, type GraphQLResolveInfo, type ValidationRule } from "graphql";
import { ZodError } from "zod";
import { ApiError } from "@/lib/http/errors";
import { requireWrite, type ApiContext } from "@/lib/api/context";
import { listLeads } from "@/lib/leads/list";
import { getLeadDetail } from "@/lib/agent/queue";
import { createManualLead } from "@/lib/leads/manual";
import { deleteLeads, restoreLeads, updateLead } from "@/lib/leads/edit";
import { saveOutcome, setStage } from "@/lib/agent/outcome";
import { bulkAssign } from "@/lib/leads/bulk";
import { listCalls } from "@/lib/calls/list";
import { listDispositions, listProcesses } from "@/lib/admin/processes";
import { listUsers } from "@/lib/admin/users";
import { isUuid } from "@/lib/db/tenant";

export const typeDefs = /* GraphQL */ `
"Any JSON value (custom lead fields)."
scalar JSON

type Query {
  "Who this request acts as."
  me: Me!
  "Leads in your scope. Keyset paging: pass endCursor as after (next) or startCursor as before (previous)."
  leads(filter: LeadFilter, sort: LeadSort = newest, first: Int = 50, after: String, before: String): LeadConnection!
  "One lead with contact, custom fields, outcomes and timeline."
  lead(id: ID!): LeadDetail
  "Call log in your scope (agents: own calls)."
  calls(filter: CallFilter, first: Int = 50, after: String): CallConnection!
  "Processes with stages and active outcomes."
  processes: [Process!]!
  "Team members (no phone numbers or emails)."
  users: [User!]!
}

type Mutation {
  "Create a lead; merges into the open lead with the same number/email."
  createLead(input: CreateLeadInput!): CreateLeadResult!
  "Partial update: omitted fields stay as they are."
  updateLead(id: ID!, input: UpdateLeadInput!): LeadDetail!
  "Move leads to the Recycle bin (admins)."
  deleteLeads(ids: [ID!]!): BulkResult!
  "Restore leads from the Recycle bin (admins)."
  restoreLeads(ids: [ID!]!): BulkResult!
  "Move a lead to a stage; the won stage converts it."
  setStage(id: ID!, stage: String!): LeadDetail!
  "Save a call outcome; callbackAt (ISO time) is required for callback outcomes."
  saveOutcome(id: ID!, outcomeId: ID!, note: String, callbackAt: String): LeadDetail!
  "Reassign up to 200 leads to one agent (supervisors and admins)."
  assignLeads(ids: [ID!]!, ownerId: ID!): BulkResult!
}

type Me {
  userId: ID!
  name: String!
  role: String!
  workspace: Workspace!
  via: String!
  scope: String!
}

type Workspace {
  id: ID!
  slug: String!
  name: String!
  timezone: String!
}

enum LeadSort {
  newest
  oldest
  name
  callback
  activity
}

input LeadFilter {
  q: String
  status: String
  stage: [String!]
  source: [String!]
  owner: [String!]
  process: [ID!]
  flag: [String!]
  created: String
}

type LeadConnection {
  items: [Lead!]!
  endCursor: String
  startCursor: String
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  "Matching leads (only computed when requested)."
  total: Int!
}

type Lead {
  id: ID!
  name: String!
  phone: String!
  email: String
  processId: ID!
  processName: String!
  source: String!
  campaign: String
  stage: String!
  status: String!
  ownerId: ID
  owner: String
  lastOutcome: String
  attempts: Int!
  nextCallbackAt: String
  lastActivityAt: String
  createdAt: String!
  city: String
}

type LeadDetail {
  id: ID!
  name: String!
  phone: String!
  email: String
  status: String!
  stage: String!
  stages: [String!]!
  processId: ID!
  processName: String!
  source: String!
  campaign: String
  attempts: Int!
  owner: String
  ownerId: ID
  dnc: Boolean!
  nextCallbackAt: String
  lastOutcome: String
  createdAt: String!
  custom: JSON!
  outcomes: [Outcome!]!
  timeline: [TimelineEntry!]!
}

type Outcome {
  id: ID!
  label: String!
  category: String!
  code: String
}

type TimelineEntry {
  id: ID!
  kind: String!
  title: String!
  detail: String
  at: String!
  by: String
  callId: ID
  hasRecording: Boolean
}

input CallFilter {
  q: String
  direction: String
  result: String
  agent: ID
  recording: Boolean
  range: String
}

type CallConnection {
  items: [Call!]!
  endCursor: String
  hasNextPage: Boolean!
  total: Int!
}

type Call {
  id: ID!
  startedAt: String!
  direction: String!
  status: String!
  durationSec: Int
  talkSec: Int
  hasRecording: Boolean!
  "Play with the same auth: GET this path."
  recordingPath: String
  leadId: ID
  leadName: String
  customer: String!
  agentName: String
  processName: String
  outcome: String
}

type Process {
  id: ID!
  name: String!
  status: String!
  stages: [String!]!
  wonStage: String!
  outcomes: [Outcome!]!
}

type User {
  id: ID!
  name: String!
  role: String!
  status: String!
  isAvailable: Boolean!
  processIds: [ID!]!
}

input CreateLeadInput {
  processId: ID!
  name: String!
  phone: String
  email: String
  city: String
  note: String
  campaign: String
  ownerId: ID
  custom: JSON
}

type CreateLeadResult {
  outcome: String!
  leadId: ID!
}

input UpdateLeadInput {
  name: String
  phone: String
  email: String
  campaign: String
  stage: String
  ownerId: ID
  custom: JSON
}

type BulkResult {
  done: Int!
  skipped: Int!
}
`;

type Ctx = { api: ApiContext };
const MAX_DEPTH = 6;

const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? ast.value : ast.kind === Kind.INT || ast.kind === Kind.FLOAT ? Number(ast.value) : ast.kind === Kind.BOOLEAN ? ast.value : null),
});

/** Did the client select this top-level field (skip work it didn't ask for)? */
function selected(info: GraphQLResolveInfo, field: string): boolean {
  return info.fieldNodes.some((n) => n.selectionSet?.selections.some((s) => s.kind === Kind.FIELD && s.name.value === field));
}

const csv = (v?: string[] | null) => (v?.length ? v.join(",") : undefined);
const strs = (o: Record<string, unknown> | null | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]));

function write(c: Ctx) {
  requireWrite(c.api);
  return c.api;
}

export const resolvers = {
  JSON: JSONScalar,
  Query: {
    me: (_: unknown, __: unknown, c: Ctx) => ({
      userId: c.api.actor.userId,
      name: c.api.actor.name,
      role: c.api.actor.role,
      workspace: { id: c.api.tenantId, slug: c.api.tenantSlug, name: c.api.tenantName, timezone: c.api.timezone },
      via: c.api.via,
      scope: c.api.scope,
    }),
    leads: async (_: unknown, a: { filter?: Record<string, unknown> | null; sort?: string; first?: number; after?: string; before?: string }, c: Ctx, info: GraphQLResolveInfo) => {
      const f = a.filter ?? {};
      const page = await listLeads(
        c.api,
        {
          q: (f.q as string) ?? undefined,
          status: (f.status as "open") ?? undefined,
          stage: csv(f.stage as string[]),
          source: csv(f.source as string[]),
          owner: csv(f.owner as string[]),
          process: csv(f.process as string[]),
          flag: csv(f.flag as string[]),
          created: (f.created as "today") ?? undefined,
          sort: a.sort as "newest",
          limit: Math.min(Math.max(a.first ?? 50, 1), 100),
          cursor: a.after ?? undefined,
          before: a.before ?? undefined,
        },
        { withTotal: selected(info, "total") },
      );
      return {
        items: page.items.map((l) => ({ ...l, lastOutcome: l.lastDisposition })),
        endCursor: page.nextCursor,
        startCursor: page.prevCursor,
        hasNextPage: !!page.nextCursor,
        hasPreviousPage: !!page.prevCursor,
        total: page.total,
      };
    },
    lead: async (_: unknown, a: { id: string }, c: Ctx) => {
      if (!isUuid(a.id)) return null;
      try {
        return toDetail(await getLeadDetail(c.api, a.id));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    calls: async (_: unknown, a: { filter?: Record<string, unknown> | null; first?: number; after?: string }, c: Ctx) => {
      const f = a.filter ?? {};
      const page = await listCalls(c.api, {
        q: (f.q as string) ?? undefined,
        direction: (f.direction as "inbound") ?? undefined,
        result: (f.result as "connected") ?? undefined,
        agent: (f.agent as string) ?? undefined,
        recording: f.recording ? "yes" : undefined,
        range: (f.range as "7d") ?? undefined,
        limit: Math.min(Math.max(a.first ?? 50, 1), 100),
        cursor: a.after ?? undefined,
      });
      return {
        items: page.items.map((x) => ({ ...x, recordingPath: x.hasRecording ? `/api/v1/calls/${x.id}/recording` : null })),
        endCursor: page.nextCursor,
        hasNextPage: !!page.nextCursor,
        total: page.total,
      };
    },
    processes: async (_: unknown, __: unknown, c: Ctx, info: GraphQLResolveInfo) => {
      const procs = await listProcesses(c.api);
      const wantOutcomes = selected(info, "outcomes");
      return Promise.all(
        procs.map(async (p) => ({
          ...p,
          outcomes: wantOutcomes ? (await listDispositions(c.api, p.id)).filter((d) => d.isActive) : [],
        })),
      );
    },
    users: async (_: unknown, __: unknown, c: Ctx) => (await listUsers(c.api)).map((u) => ({ ...u, processIds: u.processIds })),
  },
  Mutation: {
    createLead: async (_: unknown, a: { input: Record<string, unknown> }, c: Ctx) => {
      const api = write(c);
      const { custom, ...rest } = a.input;
      return createManualLead(api, { ...(rest as { processId: string; name: string }), custom: (custom as Record<string, string>) ?? {} }, api.via === "api_key" ? "api" : "manual");
    },
    updateLead: async (_: unknown, a: { id: string; input: Record<string, unknown> }, c: Ctx) => {
      const api = write(c);
      const { custom, ...rest } = a.input;
      await updateLead(api, { ...(rest as Record<string, string>), leadId: a.id, custom: strs(custom as Record<string, unknown>) });
      return toDetail(await getLeadDetail(api, a.id));
    },
    deleteLeads: async (_: unknown, a: { ids: string[] }, c: Ctx) => {
      const r = await deleteLeads(write(c), { leadIds: a.ids });
      return { done: r.deleted, skipped: r.skipped };
    },
    restoreLeads: async (_: unknown, a: { ids: string[] }, c: Ctx) => {
      const r = await restoreLeads(write(c), { leadIds: a.ids });
      return { done: r.restored, skipped: r.skipped };
    },
    setStage: async (_: unknown, a: { id: string; stage: string }, c: Ctx) => {
      const api = write(c);
      await setStage(api, { leadId: a.id, stage: a.stage });
      return toDetail(await getLeadDetail(api, a.id));
    },
    saveOutcome: async (_: unknown, a: { id: string; outcomeId: string; note?: string; callbackAt?: string }, c: Ctx) => {
      const api = write(c);
      await saveOutcome(api, { leadId: a.id, dispositionId: a.outcomeId, note: a.note ?? "", callbackAt: a.callbackAt ?? undefined });
      return toDetail(await getLeadDetail(api, a.id));
    },
    assignLeads: async (_: unknown, a: { ids: string[]; ownerId: string }, c: Ctx) => {
      const r = await bulkAssign(write(c), { leadIds: a.ids, ownerId: a.ownerId });
      return { done: r.moved, skipped: r.skipped };
    },
  },
};

function toDetail(d: Awaited<ReturnType<typeof getLeadDetail>>) {
  return { ...d, lastOutcome: d.lastDisposition };
}

/** Reject queries nested deeper than MAX_DEPTH (cheap guard against abusive queries). */
export const depthLimit: ValidationRule = (context) => {
  type Sel = { name?: { value: string }; selectionSet?: { selections: readonly unknown[] } };
  const depthOf = (sel: Sel, d: number): number => {
    if (!sel.selectionSet) return d;
    // Introspection (__schema, __type…) nests deeply by design — GraphiQL and codegen need it.
    const own = sel.selectionSet.selections.filter((s) => !(s as Sel).name?.value.startsWith("__"));
    return Math.max(d, ...own.map((s) => depthOf(s as Sel, d + 1)));
  };
  return {
    OperationDefinition(node) {
      const d = depthOf(node as unknown as { selectionSet: { selections: readonly unknown[] } }, 0);
      if (d > MAX_DEPTH) context.reportError(new GraphQLError(`Query is too deep (${d} > ${MAX_DEPTH})`, { extensions: { code: "QUERY_TOO_DEEP" } }));
    },
  };
};

/** Map our errors to GraphQL errors with a stable code; hide anything unexpected. */
export function toGraphQLError(err: unknown): GraphQLError {
  // Recognise errors by name/shape, not instanceof: graphql ships CJS + ESM builds and
  // yoga may load the other one (dual-package hazard), so instanceof GraphQLError fails.
  const isGql = (e: unknown): e is GraphQLError => !!e && typeof e === "object" && (e as Error).name === "GraphQLError";
  let original: unknown = err;
  for (let i = 0; i < 5 && isGql(original) && original.originalError; i++) original = original.originalError;
  const o = original as { name?: string; status?: number; code?: string; message?: string; issues?: { path: (string | number)[]; message: string }[] };
  if (o instanceof ApiError || (o?.name === "ApiError" && typeof o.status === "number")) {
    return new GraphQLError(o.message ?? "Error", { extensions: { code: o.code, http: { status: o.status } } });
  }
  if (o instanceof ZodError || (o?.name === "ZodError" && Array.isArray(o.issues))) {
    const i = o.issues?.[0];
    return new GraphQLError(`${i?.path.join(".") || "input"}: ${i?.message ?? "invalid"}`, { extensions: { code: "invalid_input" } });
  }
  if (isGql(original)) return new GraphQLError(original.message, { extensions: original.extensions }); // syntax / validation errors
  return new GraphQLError("Something went wrong", { extensions: { code: "internal" } });
}
