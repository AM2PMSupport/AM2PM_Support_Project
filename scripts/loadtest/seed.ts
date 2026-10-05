/**
 * Load test — seed an ISOLATED database (a Neon branch, never production)
 * with N test clients × A agents: process, mapped DID, CallerDesk telephony
 * integration (webhook secret), a lead source, accounts + memberships.
 * Writes scripts/loadtest output JSON (session cookies, webhook URLs/keys)
 * to the path in LT_OUT — keep it out of git (it holds test secrets).
 *
 * Refuses to run unless LT_ALLOW_SEED=1 and the database host is the
 * load-test branch passed in LT_BRANCH_HOST, so it can't touch production.
 *
 *   LT_ALLOW_SEED=1 LT_BRANCH_HOST=ep-… LT_OUT=/tmp/lt.json \
 *   node --env-file=<branch env> --import tsx scripts/loadtest/seed.ts 250 2
 */
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as s from "@/lib/db/schema";
import { encrypt, randomToken, sha256Hex } from "@/lib/crypto";
import { sessionToken } from "@/lib/auth/cookie";
import { SESSION_COOKIE } from "@/lib/auth/token";

const [tenantsArg = "250", agentsArg = "2"] = process.argv.slice(2);
const TENANTS = Number(tenantsArg);
const AGENTS = Number(agentsArg);

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? "";
  if (process.env.LT_ALLOW_SEED !== "1" || !process.env.LT_BRANCH_HOST || !url.includes(process.env.LT_BRANCH_HOST)) {
    throw new Error("Refusing to seed: set LT_ALLOW_SEED=1 and LT_BRANCH_HOST to the load-test branch host");
  }
  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool, { schema: s });
  const out: { tenants: unknown[] } = { tenants: [] };
  const run = Date.now().toString(36);

  for (let t = 0; t < TENANTS; t++) {
    const slug = `lt-${run}-${String(t).padStart(3, "0")}`;
    const [tenant] = await db.insert(s.tenants).values({ name: `Load test ${t}`, slug, timezone: "Asia/Kolkata" }).returning();
    const tid = tenant!.id;
    const [proc] = await db.insert(s.processes).values({ tenantId: tid, name: "Sales", stages: ["New", "Contacted", "Won"], wonStage: "Won", assignment: { method: "equal", sticky: false, slaMinutes: 15 } }).returning();
    const webhookKey = randomToken(24);
    const [integ] = await db.insert(s.integrations).values({ tenantId: tid, kind: "telephony", provider: "callerdesk", credentialsEnc: encrypt(JSON.stringify({ authCode: "LOADTEST" })), webhookSecretEnc: encrypt(webhookKey) }).returning();
    const did10 = `79${String(10_000_000 + t).slice(-8)}`;
    await db.insert(s.telephonyDids).values({ tenantId: tid, integrationId: integ!.id, number: `0${did10}`, number10: did10, processId: proc!.id, direction: "both" });
    const sourceKey = randomToken(24);
    const [src] = await db.insert(s.importSources).values({ tenantId: tid, kind: "web_form", processId: proc!.id, secretHash: sha256Hex(sourceKey) }).returning();

    const agents: { cookie: string; phone10: string }[] = [];
    for (let a = 0; a < AGENTS; a++) {
      const email = `agent${a}@${slug}.loadtest`;
      const phone10 = `6${String(100_000_000 + t * 10 + a).slice(-9)}`;
      const [acc] = await db.insert(s.accounts).values({ email }).returning();
      const [u] = await db.insert(s.users).values({ tenantId: tid, accountId: acc!.id, email, name: `Agent ${t}.${a}`, role: "agent", isAvailable: true, maxOpenLeads: 100000, agentPhone10: phone10, agentPhoneE164: `+91${phone10}` }).returning();
      await db.insert(s.userProcesses).values({ tenantId: tid, userId: u!.id, processId: proc!.id });
      const token = sessionToken(acc!.id, { userId: u!.id, role: "agent", name: `Agent ${t}.${a}`, tenantId: tid, tenantName: tenant!.name, tenantSlug: slug, tenantTimezone: "Asia/Kolkata" });
      agents.push({ cookie: `${SESSION_COOKIE}=${token}`, phone10 });
    }
    out.tenants.push({ slug, did: `0${did10}`, webhookKey, sourceId: src!.id, sourceKey, agents });
    if (t % 25 === 0) console.log(`seeded ${t + 1}/${TENANTS}`);
  }
  writeFileSync(process.env.LT_OUT ?? "loadtest-seed.json", JSON.stringify(out), { mode: 0o600 });
  console.log(`done: ${TENANTS} clients × ${AGENTS} agents`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
