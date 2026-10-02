/**
 * `npm run seed:demo` — demo process + leads in the "am2pm" workspace so the
 * console, leads list and Floor have something real to show.
 *
 * Safety: demo phone numbers use the +91 5xxxx series, which is not issued
 * to mobiles in India — a click-to-call on a demo lead can never ring a real
 * person. Everything is tagged campaign "Demo data".
 *
 *   npm run seed:demo            create (skips if the demo process exists)
 *   npm run seed:demo -- --remove   delete the demo process and all its leads
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { DEFAULT_DISPOSITIONS } from "@/lib/admin/processes";

const PROCESS_NAME = "Demo · Sales (sample leads)";
const PEOPLE = [
  ["Ananya Iyer", "Bengaluru", "meta_ads", "Hot"], ["Mohit Bansal", "Delhi", "inbound_call", "New"], ["Fatima Shaikh", "Mumbai", "web_form", "New"],
  ["Gurpreet Sandhu", "Ludhiana", "google_ads", "Warm"], ["Sneha Kulkarni", "Pune", "indiamart", "New"], ["Arjun Reddy", "Hyderabad", "justdial", "Warm"],
  ["Kavya Menon", "Kochi", "meta_ads", "New"], ["Imran Qureshi", "Mumbai", "csv", "Cold"], ["Divya Agarwal", "Jaipur", "web_form", "Hot"],
  ["Rahul Sharma", "Lucknow", "meta_ads", "New"], ["Pooja Desai", "Ahmedabad", "web_form", "Warm"], ["Vikram Rao", "Chennai", "google_ads", "New"],
] as const;

async function main() {
  const remove = process.argv.includes("--remove");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL, max: 1 });
  const db = drizzle(pool, { schema: s });
  const [tenant] = await db.select().from(s.tenants).where(eq(s.tenants.slug, "am2pm"));
  if (!tenant) throw new Error('Workspace "am2pm" not found — run npm run seed:users first');
  const tenantId = tenant.id;
  const [existing] = await db.select().from(s.processes).where(and(eq(s.processes.tenantId, tenantId), eq(s.processes.name, PROCESS_NAME)));

  if (remove) {
    if (existing) {
      const leadRows = await db.select({ id: s.leads.id, contactId: s.leads.contactId }).from(s.leads).where(eq(s.leads.processId, existing.id));
      const leadIds = leadRows.map((l) => l.id);
      if (leadIds.length) {
        await db.delete(s.interactions).where(inArray(s.interactions.leadId, leadIds));
        await db.delete(s.leads).where(inArray(s.leads.id, leadIds));
        await db.delete(s.contacts).where(inArray(s.contacts.id, leadRows.map((l) => l.contactId)));
      }
      await db.delete(s.dispositions).where(eq(s.dispositions.processId, existing.id));
      await db.delete(s.userProcesses).where(eq(s.userProcesses.processId, existing.id));
      await db.delete(s.assignmentState).where(eq(s.assignmentState.processId, existing.id));
      await db.delete(s.processes).where(eq(s.processes.id, existing.id));
      await db.execute(sql`update users u set open_leads = (select count(*) from leads l where l.assigned_to = u.id and l.status = 'open') where u.tenant_id = ${tenantId}`);
      console.log(`Removed demo process and ${leadIds.length} leads.`);
    } else console.log("No demo data to remove.");
    await pool.end();
    return;
  }
  if (existing) {
    console.log("Demo process already exists — nothing to do (use --remove first to recreate).");
    await pool.end();
    return;
  }

  const [p] = await db
    .insert(s.processes)
    .values({
      tenantId,
      name: PROCESS_NAME,
      stages: ["New", "Hot", "Warm", "Cold", "Won"],
      wonStage: "Won",
      assignment: { method: "equal", sticky: false, slaMinutes: 15, recycleHours: 48, workingHours: { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:30" } },
    })
    .returning();
  await db.insert(s.dispositions).values(DEFAULT_DISPOSITIONS.map((d, i) => ({ ...d, tenantId, processId: p!.id, sortOrder: i })));

  // Map staff who work leads to the demo process.
  const staff = await db.select().from(s.users).where(and(eq(s.users.tenantId, tenantId), inArray(s.users.role, ["agent", "process_coordinator", "manager", "project_supervisor"])));
  if (staff.length) await db.insert(s.userProcesses).values(staff.map((u) => ({ tenantId, userId: u.id, processId: p!.id }))).onConflictDoNothing();
  const agent = staff.find((u) => u.role === "agent");
  if (!agent) throw new Error("Demo Agent not found — run npm run seed:users first");

  const now = Date.now();
  let open = 0;
  for (const [i, [name, city, source, stage]] of PEOPLE.entries()) {
    const ten = `55${String(10000000 + i * 7919).slice(-8)}`; // +91 55xxxxxxxx — not a mobile series
    const [c] = await db
      .insert(s.contacts)
      .values({ tenantId, name, phoneE164: `+91${ten}`, phoneKey: ten, email: `${name.split(" ")[0]!.toLowerCase()}.demo@example.com` })
      .returning();
    const createdAt = new Date(now - (i % 4 === 0 ? 26 * 3600_000 : (i + 1) * 9 * 60_000));
    const [lead] = await db
      .insert(s.leads)
      .values({
        tenantId,
        processId: p!.id,
        contactId: c!.id,
        source: { kind: source, campaign: "Demo data" },
        stage,
        assignedTo: agent.id,
        assignedAt: createdAt,
        attempts: stage === "New" ? 0 : (i % 3) + 1,
        dedupeKey: ten,
        custom: { city },
        createdAt,
        lastEnquiryAt: createdAt,
      })
      .returning();
    open++;
    await db.insert(s.leadEvents).values([
      { tenantId, leadId: lead!.id, type: "created", actor: { kind: "source", name: source }, after: { source: { kind: source } }, createdAt },
      { tenantId, leadId: lead!.id, type: "assigned", actor: { kind: "system", name: "equal" }, after: { assignedTo: agent.id }, createdAt },
    ]);
    // A few callbacks (overdue / upcoming) and one missed inbound call.
    const due = i === 0 ? -12 : i === 3 ? 25 : i === 5 ? 95 : null;
    if (due !== null) {
      await db.insert(s.callbacks).values({ tenantId, leadId: lead!.id, assignedTo: agent.id, dueAt: new Date(now + due * 60_000), reason: "agent" });
      await db.update(s.leads).set({ nextCallbackAt: new Date(now + due * 60_000), lastDisposition: { code: "CALL_BACK", label: "Call back", category: "callback", at: new Date(now - 86400_000).toISOString() } }).where(eq(s.leads.id, lead!.id));
    }
    if (source === "inbound_call") {
      await db.insert(s.interactions).values({ tenantId, type: "call", direction: "inbound", leadId: lead!.id, contactId: c!.id, processId: p!.id, status: "missed", startedAt: createdAt, customerNumber: `+91${ten}` });
      await db.insert(s.callbacks).values({ tenantId, leadId: lead!.id, assignedTo: agent.id, dueAt: createdAt, reason: "missed_call" });
    }
  }
  await db.update(s.users).set({ openLeads: sql`${s.users.openLeads} + ${open}`, isAvailable: true }).where(eq(s.users.id, agent.id));
  console.log(`Created "${PROCESS_NAME}" with ${PEOPLE.length} demo leads for ${agent.email}; mapped ${staff.length} staff.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
