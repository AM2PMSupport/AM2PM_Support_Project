/**
 * Read routing on real Postgres (PGlite): least-connections choice among
 * replicas, failover to the primary when a replica is down, read-only
 * enforcement, and RLS on the read path.
 *
 * PGlite has one database, so "replicas" here are targets pointing at it
 * with controllable load / failure — the routing logic is what is tested.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { setReplicasForTests, type Db, type ReadTarget } from "@/lib/db/client";
import { withTenant, withTenantRead } from "@/lib/db/tenant";
import { createTestDb, seedTenant, type TestDb } from "../helpers/db";
import type { TenantContext } from "@/lib/tenancy/context";

let db: TestDb;
let close: () => Promise<void>;
let A: TenantContext;
let B: TenantContext;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  A = await seedTenant(db, "read-a");
  B = await seedTenant(db, "read-b");
  await withTenant(A, (tx) => tx.insert(s.contacts).values({ name: "A1" }));
}, 60_000);
afterAll(async () => close());

/** A replica target backed by the test DB, wrapped to record use. */
function replica(name: string, active: number, used: string[], opts: { down?: boolean } = {}): ReadTarget {
  const real = db as unknown as Db;
  const failing = {
    transaction: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
  } as unknown as Db;
  const wrapped = new Proxy(opts.down ? failing : real, {
    get(target, prop, receiver) {
      if (prop === "transaction") used.push(name);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: wrapped, name, load: () => ({ active, waiting: 0 }), unhealthyUntil: 0, lastPicked: 0 };
}

describe("withTenantRead", () => {
  it("routes to the replica with the fewest active connections", async () => {
    const used: string[] = [];
    setReplicasForTests([replica("replica-1", 6, used), replica("replica-2", 1, used), replica("replica-3", 4, used)]);
    const rows = await withTenantRead(A, (tx) => tx.select().from(s.contacts));
    expect(rows.map((r) => r.name)).toEqual(["A1"]);
    expect(used).toEqual(["replica-2"]);
  });

  it("fails over to the primary when the chosen replica is down, and opens its circuit", async () => {
    const used: string[] = [];
    const down = replica("replica-1", 0, used, { down: true });
    setReplicasForTests([down]);
    const rows = await withTenantRead(A, (tx) => tx.select().from(s.contacts));
    expect(rows).toHaveLength(1); // served by the primary
    expect(down.unhealthyUntil).toBeGreaterThan(Date.now());

    // While the circuit is open, the next read goes straight to the primary.
    used.length = 0;
    await withTenantRead(A, (tx) => tx.select().from(s.contacts));
    expect(used).toEqual([]);
  });

  it("uses the primary when no replicas are configured", async () => {
    setReplicasForTests([]);
    expect(await withTenantRead(A, (tx) => tx.select().from(s.contacts))).toHaveLength(1);
  });

  it("is read-only: writes are rejected", async () => {
    setReplicasForTests([]);
    await expect(withTenantRead(A, (tx) => tx.insert(s.contacts).values({ name: "nope" }))).rejects.toThrow();
  });

  it("keeps tenant isolation on the read path", async () => {
    setReplicasForTests([]);
    const seenByB = await withTenantRead(B, (tx) => tx.select().from(s.contacts).where(eq(s.contacts.name, "A1")));
    expect(seenByB).toEqual([]);
  });
});
