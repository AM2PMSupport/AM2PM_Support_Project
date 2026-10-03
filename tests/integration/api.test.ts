/**
 * REST v1 + GraphQL on real Postgres (RLS), through the real route handlers:
 * API keys (read vs write, revoked, unknown, cross-workspace), lead create /
 * read / update / delete, GraphQL queries + mutations with the same rules.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTestDb, fakeRedis, seedTenant, type TestDb } from "../helpers/db";
import type { SessionContext } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";

process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.CRON_SECRET ??= "test-cron-secret-0123456789";
process.env.AUTH_SECRET ??= "test-auth-secret-0123456789abcdef0123456789";
vi.mock("@/lib/queue/qstash", () => ({ enqueue: vi.fn(async () => "msg"), verifyQStash: vi.fn() }));
const r = fakeRedis();
vi.mock("@/lib/redis/client", async (orig) => ({ ...(await orig<typeof import("@/lib/redis/client")>()), redis: () => r }));

const { createApiKey, revokeApiKey } = await import("@/lib/admin/api-keys");
const me = await import("@/app/api/v1/me/route");
const leadsRoute = await import("@/app/api/v1/leads/route");
const leadRoute = await import("@/app/api/v1/leads/[id]/route");
const gql = await import("@/app/api/graphql/route");

let db: TestDb;
let close: () => Promise<void>;
let admin: SessionContext;
let other: SessionContext;
let processId: string;
let readKey: string;
let writeKey: string;
let otherKey: string;

async function mk(t: Awaited<ReturnType<typeof seedTenant>>, email: string, role: Role): Promise<SessionContext> {
  const base = { ...t, accountId: crypto.randomUUID(), tenantName: t.tenantSlug };
  const [u] = await withTenant({ ...base, actor: { userId: "", role, name: email } }, (tx) => tx.insert(s.users).values({ email, name: email, role }).returning());
  return { ...base, actor: { userId: u!.id, role, name: email } };
}
const req = (path: string, key: string | null, init: RequestInit = {}) =>
  new Request(`https://crm.example.test${path}`, { ...init, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", ...(init.headers ?? {}) } });
const params = <P>(p: P) => ({ params: Promise.resolve(p) });
const graphql = async (key: string | null, query: string, variables?: Record<string, unknown>) => {
  const res = await gql.POST(req("/api/graphql", key, { method: "POST", body: JSON.stringify({ query, variables }) }));
  return (await res.json()) as { data?: Record<string, any>; errors?: { message: string; extensions?: { code?: string } }[] };
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const t = await seedTenant(db, "api-t");
  admin = await mk(t, "admin@api.test", "admin");
  other = await mk(await seedTenant(db, "api-other"), "admin@other.test", "admin");
  await withTenant(admin, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "Sales", stages: ["New", "Hot", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    processId = p!.id;
  });
  readKey = (await createApiKey(admin, { name: "Reader", scope: "read" })).key;
  writeKey = (await createApiKey(admin, { name: "Writer", scope: "write" })).key;
  otherKey = (await createApiKey(other, { name: "Other ws", scope: "write" })).key;
}, 60_000);
afterAll(async () => close());

describe("REST v1 with API keys", () => {
  it("me: identifies the key's user, workspace and scope; bad keys are 401", async () => {
    const res = await me.GET(req("/api/v1/me", readKey), params({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "admin", via: "api_key", scope: "read", workspace: { slug: "api-t" } });
    expect((await me.GET(req("/api/v1/me", "am2pm_NOTAREALKEY000000000000000000"), params({}))).status).toBe(401);
    expect((await me.GET(req("/api/v1/me", null), params({}))).status).toBe(401); // no key, no session
  });

  it("create → read → update → delete a lead; read-only key can't write", async () => {
    const body = JSON.stringify({ processId, name: "API Lead", phone: "+91 98765 00001", campaign: "Partner", custom: { budget: "5L" } });
    expect((await leadsRoute.POST(req("/api/v1/leads", readKey, { method: "POST", body }), params({}))).status).toBe(403);
    const created = await leadsRoute.POST(req("/api/v1/leads", writeKey, { method: "POST", body }), params({}));
    expect(created.status).toBe(201);
    const { leadId } = (await created.json()) as { leadId: string };
    // Same number again → merged, not duplicated.
    const again = await leadsRoute.POST(req("/api/v1/leads", writeKey, { method: "POST", body }), params({}));
    expect(await again.json()).toEqual({ outcome: "merged", leadId });

    const got = await (await leadRoute.GET(req(`/api/v1/leads/${leadId}`, readKey), params({ id: leadId }))).json();
    expect(got).toMatchObject({ name: "API Lead", source: "api", campaign: "Partner" });
    expect(got.custom.budget).toBe("5L");

    const patched = await leadRoute.PATCH(req(`/api/v1/leads/${leadId}`, writeKey, { method: "PATCH", body: JSON.stringify({ stage: "Hot", custom: { budget: "7L" } }) }), params({ id: leadId }));
    expect(await patched.json()).toMatchObject({ stage: "Hot", custom: { budget: "7L" } });

    const list = await (await leadsRoute.GET(req("/api/v1/leads?q=API", readKey), params({}))).json();
    expect(list.total).toBe(1);

    expect((await leadRoute.DELETE(req(`/api/v1/leads/${leadId}`, writeKey, { method: "DELETE" }), params({ id: leadId }))).status).toBe(200);
    expect((await leadRoute.GET(req(`/api/v1/leads/${leadId}`, readKey), params({ id: leadId }))).status).toBe(200); // detail still readable by id…
    expect((await (await leadsRoute.GET(req("/api/v1/leads?q=API", readKey), params({}))).json()).total).toBe(0); // …but gone from lists
  });

  it("a key never sees another workspace; invalid input is a 400 with the field name", async () => {
    const list = await (await leadsRoute.GET(req("/api/v1/leads?status=all", otherKey), params({}))).json();
    expect(list.total).toBe(0);
    const bad = await leadsRoute.POST(req("/api/v1/leads", writeKey, { method: "POST", body: JSON.stringify({ name: "x" }) }), params({}));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_input");
  });

  it("revoked keys stop working immediately", async () => {
    const k = await createApiKey(admin, { name: "Temp", scope: "read" });
    expect((await me.GET(req("/api/v1/me", k.key), params({}))).status).toBe(200);
    await revokeApiKey(admin, k.id);
    expect((await me.GET(req("/api/v1/me", k.key), params({}))).status).toBe(401);
  });
});

describe("GraphQL", () => {
  it("queries exactly the fields asked for; same scope and rules as REST", async () => {
    const created = await graphql(writeKey, `mutation($i: CreateLeadInput!) { createLead(input: $i) { outcome leadId } }`, {
      i: { processId, name: "GQL Lead", phone: "9876500002", custom: { city: "Pune" } },
    });
    expect(created.errors).toBeUndefined();
    const leadId = created.data!.createLead.leadId;

    const q = await graphql(readKey, `{ me { role scope workspace { slug } } leads(filter: { q: "GQL" }, first: 5) { items { id name source stage } hasNextPage } lead(id: "${leadId}") { name custom stages outcomes { label } } processes { name stages } }`);
    expect(q.errors).toBeUndefined();
    expect(q.data!.me).toEqual({ role: "admin", scope: "read", workspace: { slug: "api-t" } });
    expect(q.data!.leads.items).toEqual([{ id: leadId, name: "GQL Lead", source: "api", stage: "New" }]);
    expect(q.data!.lead.custom.city).toBe("Pune");
    expect(q.data!.processes.map((p: { name: string }) => p.name)).toEqual(["Sales"]);

    // Custom-field + system filters work over GraphQL exactly like the screens.
    const f = await graphql(readKey, `{ leads(filter: { custom: { city: "~pun" }, flag: ["not_called"] }) { items { name } } }`);
    expect(f.errors).toBeUndefined();
    expect(f.data!.leads.items).toEqual([{ name: "GQL Lead" }]);
    const none = await graphql(readKey, `{ leads(filter: { custom: { city: "~delhi" } }) { items { name } } }`);
    expect(none.data!.leads.items).toEqual([]);

    const upd = await graphql(writeKey, `mutation { setStage(id: "${leadId}", stage: "Hot") { stage } }`);
    expect(upd.data!.setStage.stage).toBe("Hot");
  });

  it("read-only keys can't mutate; unauthenticated calls and introspection are rejected; other workspace can't see the lead", async () => {
    const ro = await graphql(readKey, `mutation { deleteLeads(ids: []) { done } }`);
    expect(ro.errors?.[0]?.extensions?.code).toBe("read_only_key");
    const anon = await graphql(null, `{ me { name } }`);
    expect(anon.errors?.[0]?.extensions?.code).toBe("unauthorized");
    expect((await graphql(readKey, `{ lead(id: "not-a-uuid") { id } }`)).data!.lead).toBeNull();
    // Full introspection (what GraphiQL / codegen send) is allowed for authenticated callers.
    const intro = await graphql(readKey, `{ __schema { types { name fields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } } } } }`);
    expect(intro.errors).toBeUndefined();
    expect(intro.data!.__schema.types.some((t: { name: string }) => t.name === "LeadDetail")).toBe(true);
    expect((await graphql(null, `{ __schema { types { name } } }`)).errors?.[0]?.extensions?.code).toBe("unauthorized");
    const leads = await graphql(otherKey, `{ leads(filter: { status: "all" }) { items { id } } }`);
    expect(leads.data!.leads.items).toEqual([]);
  });
});
