/**
 * `npm run seed:users` — create one sign-in account per role.
 *
 * - Workspaces: "am2pm" (AM2PM Support, the BPO — staff roles) and
 *   "demo-client" (a client organisation — the Client role belongs there,
 *   DESIGN.md §6 / §7).
 * - Passwords: 20 random characters each (lib/auth/password.ts). Only the
 *   scrypt HASH goes into the database.
 * - Plain passwords are written ONLY to ./PASSWORD.md (git-ignored, file
 *   mode 600) and are never printed to the console.
 * - Idempotent: existing accounts are left unchanged. Pass --reset to rotate
 *   every seeded password (PASSWORD.md is rewritten).
 *
 * Run: node --env-file=.env.local --import tsx scripts/seed-users.ts [--reset]
 */
import { chmodSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { generatePassword, hashPassword } from "@/lib/auth/password";

const { accounts, tenants, users } = schema;

const WORKSPACES = [
  { slug: "am2pm", name: "AM2PM Support" },
  { slug: "demo-client", name: "Demo Client" },
] as const;

const ACCOUNTS: { role: schema.Role; name: string; email: string; workspace: (typeof WORKSPACES)[number]["slug"] }[] = [
  { role: "super_admin", name: "Super Admin", email: "superadmin@am2pmsupport.com", workspace: "am2pm" },
  { role: "admin", name: "Workspace Admin", email: "admin@am2pmsupport.com", workspace: "am2pm" },
  { role: "project_supervisor", name: "Project Supervisor", email: "supervisor@am2pmsupport.com", workspace: "am2pm" },
  { role: "manager", name: "Floor Manager", email: "manager@am2pmsupport.com", workspace: "am2pm" },
  { role: "process_coordinator", name: "Process Coordinator", email: "coordinator@am2pmsupport.com", workspace: "am2pm" },
  { role: "trainer", name: "Lead Trainer", email: "trainer@am2pmsupport.com", workspace: "am2pm" },
  { role: "agent", name: "Demo Agent", email: "agent@am2pmsupport.com", workspace: "am2pm" },
  { role: "client", name: "Client Viewer", email: "client@demo-client.am2pmsupport.com", workspace: "demo-client" },
];

async function main() {
  const reset = process.argv.includes("--reset");
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL_UNPOOLED in .env.local");
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  // Runs as the owner role (seeding is platform-level), so tenant_id is set explicitly.
  const tenantIds = new Map<string, string>();
  for (const w of WORKSPACES) {
    await db.insert(tenants).values({ name: w.name, slug: w.slug }).onConflictDoNothing();
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, w.slug));
    tenantIds.set(w.slug, t!.id);
  }

  const rows: { role: string; email: string; workspace: string; password: string | null }[] = [];
  for (const a of ACCOUNTS) {
    const tenantId = tenantIds.get(a.workspace)!;
    const email = a.email.toLowerCase();
    // One login (accounts) per person + a membership (users) in the workspace.
    const [acc] = await db.select({ id: accounts.id, passwordHash: accounts.passwordHash }).from(accounts).where(eq(accounts.email, email));
    const [member] = await db.select({ id: users.id, accountId: users.accountId }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.email, email)));
    if (acc?.passwordHash && member?.accountId === acc.id && !reset) {
      rows.push({ role: a.role, email, workspace: a.workspace, password: null });
      console.log(`= ${email} exists (unchanged)`);
      continue;
    }
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    const accountId = acc
      ? (await db.update(accounts).set({ passwordHash, passwordChangedAt: new Date() }).where(eq(accounts.id, acc.id)).returning({ id: accounts.id }))[0]!.id
      : (await db.insert(accounts).values({ email, passwordHash, passwordChangedAt: new Date(), lastTenantId: tenantId }).returning({ id: accounts.id }))[0]!.id;
    if (member) {
      await db.update(users).set({ accountId, status: "active" }).where(eq(users.id, member.id));
      console.log(`↻ ${email} password ${acc ? "rotated" : "set"}`);
    } else {
      await db.insert(users).values({ tenantId, accountId, email, name: a.name, role: a.role, isAvailable: a.role === "agent" });
      console.log(`+ ${email} created (${a.role})`);
    }
    rows.push({ role: a.role, email, workspace: a.workspace, password });
  }
  await pool.end();

  if (rows.every((r) => r.password === null)) {
    console.log("No passwords changed; PASSWORD.md left as is. Use --reset to rotate.");
    return;
  }

  const md = `# PASSWORD.md — sign-in accounts (LOCAL ONLY)

> **Never commit or share this file.** It is in \`.gitignore\` and the repository is public.
> Generated ${new Date().toISOString()} by \`npm run seed:users${reset ? " -- --reset" : ""}\`.
> The database stores only scrypt hashes; these plain passwords exist only here.

Sign in at **${appUrl}/login** (production: https://am2pmsupportproject.vercel.app/login).

| Role | Login ID (email) | Password | Workspace |
| --- | --- | --- | --- |
${rows.map((r) => `| ${r.role} | \`${r.email}\` | ${r.password ? `\`${r.password}\`` : "_unchanged — see previous copy_"} | ${r.workspace} |`).join("\n")}

## Notes

- 5 wrong passwords for one email (or 30 from one IP) lock sign-in for 15 minutes.
- Rotate all of these: \`npm run seed:users -- --reset\` (rewrites this file).
- Before real clients go live: give each person their own account and delete or rotate these shared role accounts.
`;
  writeFileSync("PASSWORD.md", md, { mode: 0o600 });
  chmodSync("PASSWORD.md", 0o600);
  console.log("Wrote PASSWORD.md (mode 600, git-ignored).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
