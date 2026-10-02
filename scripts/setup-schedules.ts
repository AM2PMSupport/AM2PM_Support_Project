/**
 * `npm run setup:schedules` — create/refresh the QStash schedules that run
 * frequent jobs. Vercel Hobby allows only daily crons, so these run on
 * QStash (free plan: 10 schedules, 1,000 messages/day) and call
 * /api/jobs/<job> with a QStash signature, which the route verifies.
 *
 * Budget at these intervals: 288 + 4 × 96 = 672 messages/day (free: 1,000).
 * Target URL = PRODUCTION_URL (default the live Vercel URL), never localhost.
 * Idempotent: each schedule has a fixed id, so re-running updates in place.
 */
import { Client } from "@upstash/qstash";

const BASE = process.env.PRODUCTION_URL ?? "https://am2pmsupportproject.vercel.app";
const SCHEDULES = [
  { job: "callback-reminders", cron: "*/5 * * * *" },
  { job: "sweep-unassigned", cron: "*/15 * * * *" },
  { job: "relay-outbox", cron: "*/15 * * * *" },
  { job: "sweep-stuck-calls", cron: "*/15 * * * *" },
  // Pull CallerDesk's call report: fills in calls/recordings whose webhooks were missed.
  { job: "sync-calls", cron: "*/15 * * * *" },
];

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
      retries: 2,
    });
    console.log(`✓ ${s.job.padEnd(20)} ${s.cron.padEnd(14)} → ${BASE}/api/jobs/${s.job}`);
  }
  const all = await client.schedules.list();
  console.log(`${all.length} schedule(s) on this QStash account.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
