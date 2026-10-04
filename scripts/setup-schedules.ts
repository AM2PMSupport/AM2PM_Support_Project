/**
 * `npm run setup:schedules` — create/refresh the QStash schedules that run
 * frequent jobs. Vercel Hobby allows only daily crons, so these run on
 * QStash (free plan: 10 schedules, 1,000 messages/day) and call
 * /api/jobs/<job> with a QStash signature, which the route verifies.
 *
 * ONE schedule, `tick` every 5 min (288 messages/day of the free 1,000):
 * it runs reminders each time and the 15-minute sweeps every third run
 * (lib/jobs/handlers.ts). Five separate schedules (672/day) plus one message
 * per unassigned lead per sweep used up the daily quota by mid-morning on
 * 2026-10-03, stopping every job and webhook until midnight UTC. The old
 * per-job schedules are deleted below so a re-run can't bring them back.
 * Target URL = PRODUCTION_URL (default the live Vercel URL), never localhost.
 * Idempotent: each schedule has a fixed id, so re-running updates in place.
 */
import { Client } from "@upstash/qstash";

const BASE = process.env.PRODUCTION_URL ?? "https://am2pmsupportproject.vercel.app";
const SCHEDULES = [{ job: "tick", cron: "*/5 * * * *" }];
const RETIRED = ["callback-reminders", "sweep-unassigned", "relay-outbox", "sweep-stuck-calls", "sync-calls"];

async function main() {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("QSTASH_TOKEN missing in .env.local");
  const client = new Client({ token });
  for (const s of SCHEDULES) {
    await client.schedules.create({
      scheduleId: `am2pm-${s.job}`,
      destination: `${BASE}/api/jobs/${s.job}`,
      cron: s.cron,
      body: "{}",
      headers: { "Content-Type": "application/json" },
      retries: 0, // a missed tick is covered by the next one, 5 minutes later
    });
    console.log(`✓ ${s.job.padEnd(20)} ${s.cron.padEnd(14)} → ${BASE}/api/jobs/${s.job}`);
  }
  for (const job of RETIRED) {
    await client.schedules.delete(`am2pm-${job}`).then(
      () => console.log(`✗ removed old schedule ${job}`),
      () => undefined, // already gone
    );
  }
  const all = await client.schedules.list();
  console.log(`${all.length} schedule(s) on this QStash account.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
