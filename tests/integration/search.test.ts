/**
 * Quick search + call-lookup indexes on real Postgres (PGlite with pg_trgm
 * and btree_gin, same migrations as production).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { classifyQuery, escapeLike, searchContacts } from "@/lib/leads/search";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { TenantContext } from "@/lib/tenancy/context";

let db: TestDb;
let close: () => Promise<void>;
let A: TenantContext;
let B: TenantContext;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  A = await seedTenant(db, "search-a");
  B = await seedTenant(db, "search-b");
  await withTenant(A, async (tx) => {
    const [p] = await tx.insert(s.processes).values({ name: "Sales", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    const people = [
      { name: "Rahul Sharma", phoneE164: "+919811114321", phoneKey: "9811114321", email: "rahul.s@example.com" },
      { name: "Rahima Khan", phoneE164: "+919822225555", phoneKey: "9822225555", email: "rahima@example.org" },
      { name: "Priya 100% Sure", phoneE164: "+919833336666", phoneKey: "9833336666", email: "priya@example.com" },
    ];
    for (const person of people) {
      const [c] = await tx.insert(s.contacts).values(person).returning();
      await tx.insert(s.leads).values({ processId: p!.id, contactId: c!.id, source: { kind: "manual" }, stage: "New", dedupeKey: person.phoneKey });
    }
  });
  await withTenant(B, (tx) => tx.insert(s.contacts).values({ name: "Rahul Other-Tenant", phoneKey: "9811114321" }));
}, 60_000);
afterAll(async () => close());

describe("query classification (which index a search uses)", () => {
  it("routes by shape", () => {
    expect(classifyQuery("rahul@ex")).toEqual({ kind: "email", value: "rahul@ex" });
    expect(classifyQuery("+91 98111-14321")).toEqual({ kind: "phone_exact", value: "9811114321" });
    expect(classifyQuery("4321")).toEqual({ kind: "phone_partial", value: "4321" });
    expect(classifyQuery("  Rah ")).toEqual({ kind: "name", value: "Rah" });
    expect(classifyQuery("r")).toBeNull();
    expect(classifyQuery("12")).toBeNull();
  });

  it("escapes LIKE wildcards", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
  });
});

describe("searchContacts", () => {
  it("finds by partial name, best match first, with the contact's leads", async () => {
    const res = await searchContacts(A, "rah");
    expect(res.map((r) => r.name)).toEqual(expect.arrayContaining(["Rahul Sharma", "Rahima Khan"]));
    expect(res[0]!.leads).toHaveLength(1);
  });

  it("finds by the last digits of a phone number", async () => {
    expect((await searchContacts(A, "4321")).map((r) => r.name)).toEqual(["Rahul Sharma"]);
  });

  it("finds by a full phone number in any format", async () => {
    expect((await searchContacts(A, "+91 98222 25555")).map((r) => r.name)).toEqual(["Rahima Khan"]);
  });

  it("finds by partial email", async () => {
    expect((await searchContacts(A, "@example.org")).map((r) => r.name)).toEqual(["Rahima Khan"]);
  });

  it("treats % in the query literally", async () => {
    expect((await searchContacts(A, "100%")).map((r) => r.name)).toEqual(["Priya 100% Sure"]);
  });

  it("never returns another tenant's contacts", async () => {
    const names = (await searchContacts(A, "rahul")).map((r) => r.name);
    expect(names).not.toContain("Rahul Other-Tenant");
  });
});

describe("indexes are used by the planner", () => {
  // Realistic volume: the planner is cost-based. Measured on PGlite: at ~10K
  // contacts it rightly prefers the plain tenant index (search ~3–5 ms); from
  // ~100K it switches to the trigram indexes (~1.4–3.4 ms). Seed ~100K across
  // two tenants + ANALYZE, like a real client base, and check the choice.
  beforeAll(async () => {
    await db.execute(sql`
      insert into contacts (tenant_id, name, phone_key, email)
      select ${A.tenantId}::uuid, md5(g::text) || ' Person', lpad((7000000000 + g)::text, 10, '0'), 'p' || g || '@example.net'
      from generate_series(1, 50000) g`);
    await db.execute(sql`
      insert into contacts (tenant_id, name, phone_key)
      select ${B.tenantId}::uuid, md5((g + 1)::text), lpad((6000000000 + g)::text, 10, '0')
      from generate_series(1, 50000) g`);
    await db.execute(sql`
      insert into interactions (tenant_id, type, direction, status, customer_number, started_at)
      select ${A.tenantId}::uuid, 'call', 'outbound', 'completed', '+91' || (7000000000 + g % 900)::text, now() - (g || ' minutes')::interval
      from generate_series(1, 5000) g`);
    await db.execute(sql`
      insert into callbacks (tenant_id, lead_id, due_at, status, reason)
      select ${A.tenantId}::uuid, (select id from leads limit 1), now() + (g || ' minutes')::interval,
             case when g % 50 = 0 then 'pending' else 'done' end, 'agent'
      from generate_series(1, 5000) g`);
    await db.execute(sql`analyze contacts`);
    await db.execute(sql`analyze interactions`);
    await db.execute(sql`analyze callbacks`);
  }, 120_000);

  /** EXPLAIN with sequential scans disabled: shows which index Postgres can use. */
  async function plan(query: ReturnType<typeof sql>): Promise<string> {
    await db.execute(sql`set enable_seqscan = off`);
    const res = await db.execute(sql`explain ${query}`);
    await db.execute(sql`reset enable_seqscan`);
    return (res.rows as Record<string, string>[]).map((r) => Object.values(r)[0]).join("\n");
  }

  it("name search uses the trigram index", async () => {
    expect(await plan(sql`select id from contacts where tenant_id = ${A.tenantId}::uuid and name ilike '%rah%'`)).toContain("contacts_search_name");
  });

  it("partial phone search uses the trigram index", async () => {
    expect(await plan(sql`select id from contacts where tenant_id = ${A.tenantId}::uuid and phone_key ilike '%4321%'`)).toContain("contacts_search_phone");
  });

  it("caller history uses interactions_customer", async () => {
    expect(
      await plan(sql`select id from interactions where tenant_id = ${A.tenantId}::uuid and customer_number = '+919811114321' order by started_at desc limit 10`),
    ).toContain("interactions_customer");
  });

  it("the reminder cron uses callbacks_pending_due", async () => {
    expect(await plan(sql`select id from callbacks where status = 'pending' and due_at < now()`)).toContain("callbacks_pending_due");
  });
});
