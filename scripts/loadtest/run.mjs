/**
 * Load test — simulated agents + provider webhooks against the LB (:3200).
 * Run only against an isolated stack (scripts/loadtest/fake-services.mjs +
 * `next start` on a Neon branch); see scripts/loadtest/README.md.
 *
 * Each virtual agent behaves like the real console (components/console/live-console.tsx):
 *   idle     queueAction + callStatusAction every 20 s; bell every 30 s
 *   on call  callStatusAction every 3 s (≈40% of agents at a time, ~3 min calls)
 *   starts   loads /console (server render); opens /leads every ~2 min
 * Calls arrive as CallerDesk inbound reports (60% answered by an agent of
 * that client, 40% missed) at 2× an average day's rate (100 calls/agent/8 h);
 * leads arrive on each client's web-form source.
 *
 *   node scripts/loadtest/run.mjs <seed.json> [--smoke]
 */
import { readFileSync } from "node:fs";
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent({ connections: 512, keepAliveTimeout: 30_000, pipelining: 1 }));
const BASE = "http://localhost:3200";
const seed = JSON.parse(readFileSync(process.argv[2], "utf8"));
const SMOKE = process.argv.includes("--smoke");
const PHASES = SMOKE ? [{ agents: 4, secs: 25 }] : [{ agents: 50, secs: 60 }, { agents: 150, secs: 60 }, { agents: 300, secs: 90 }, { agents: 500, secs: 150 }];
const CALLS_PER_AGENT_PER_S = (100 / (8 * 3600)) * 2; // 2× average
const LEADS_PER_AGENT_PER_S = 40 / (8 * 3600); // ~40 leads/agent/day

// Server action ids from the build (same calls the browser makes).
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, v]) => v.exportedName === name)?.[0];
const ACT = { queue: actionId("queueAction"), status: actionId("callStatusAction"), bell: actionId("notificationsAction") };
if (!ACT.queue || !ACT.status || !ACT.bell) throw new Error("server action ids not found — run `npm run build` first");

const agents = seed.tenants.flatMap((t) => t.agents.map((a) => ({ ...a, tenant: t })));
const stats = new Map(); // kind → { lat: [], codes: {} }
let phaseName = "";
const rec = (kind, ms, code) => {
  const key = `${phaseName}|${kind}`;
  const s = stats.get(key) ?? { lat: [], codes: {} };
  s.lat.push(ms);
  s.codes[code] = (s.codes[code] ?? 0) + 1;
  stats.set(key, s);
};
async function hit(kind, url, init) {
  const t = performance.now();
  try {
    const r = await fetch(BASE + url, { ...init, signal: AbortSignal.timeout(30_000) });
    await r.arrayBuffer();
    rec(kind, performance.now() - t, r.status);
    return r.status;
  } catch (e) {
    rec(kind, performance.now() - t, e.name === "TimeoutError" ? "timeout" : "neterr");
    return 0;
  }
}
const action = (kind, a, id, args) =>
  hit(kind, "/console", { method: "POST", headers: { cookie: a.cookie, "next-action": id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" }, body: JSON.stringify(args) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.5 + Math.random());

let running = true;
let activeCount = 0;
async function agentLoop(a) {
  await hit("page:/console", "/console", { headers: { cookie: a.cookie } });
  let onCallUntil = 0;
  let nextBell = Date.now() + jitter(30_000);
  let nextLeads = Date.now() + jitter(120_000);
  while (running && a.active) {
    const now = Date.now();
    if (!onCallUntil && Math.random() < 0.4 * (20 / 180) * 1.6) onCallUntil = now + jitter(180_000); // keeps ~40% on call
    if (onCallUntil && now > onCallUntil) onCallUntil = 0;
    if (onCallUntil) {
      await action("action:callStatus(live)", a, ACT.status, []);
      await sleep(3000);
    } else {
      await action("action:queue", a, ACT.queue, [{}]);
      await action("action:callStatus", a, ACT.status, []);
      if (Date.now() > nextBell) { await action("action:bell", a, ACT.bell, []); nextBell = Date.now() + 30_000; }
      if (Date.now() > nextLeads) { await hit("page:/leads", "/leads", { headers: { cookie: a.cookie } }); nextLeads = Date.now() + jitter(120_000); }
      await sleep(jitter(20_000));
    }
  }
}

let callSeq = 0;
function callWebhook(active) {
  const a = active[Math.floor(Math.random() * active.length)];
  const t = a.tenant;
  const answered = Math.random() < 0.6;
  const cust = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const body = new URLSearchParams({
    Direction: "IVR", SourceNumber: cust, DestinationNumber: t.did, DialWhomNumber: answered ? a.phone10 : "",
    Status: answered ? "ANSWER" : "NOANSWER", CallSid: `lt-${Date.now()}-${callSeq++}`,
    StartTime: ts, EndTime: ts, CallDuration: answered ? "190" : "20", TalkDuration: answered ? "170" : "0",
  });
  return hit("webhook:telephony", `/api/hooks/${t.slug}/telephony/callerdesk/${t.webhookKey}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
}
function leadWebhook(active) {
  const t = active[Math.floor(Math.random() * active.length)].tenant;
  const phone = `8${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  return hit("webhook:lead", `/api/hooks/${t.slug}/${t.sourceId}`, { method: "POST", headers: { "content-type": "application/json", "x-source-key": t.sourceKey }, body: JSON.stringify({ name: `LT ${phone.slice(-4)}`, phone, email: `lt${phone}@example.com` }) });
}

async function webhookPump(rateFn, fire) {
  while (running) {
    const active = agents.filter((a) => a.active);
    const rate = rateFn(active.length);
    if (active.length && rate > 0) void fire(active);
    await sleep(rate > 0 ? -Math.log(1 - Math.random()) * (1000 / rate) : 1000); // Poisson arrivals
  }
}

const qstash = async () => (await fetch("http://127.0.0.1:8081/stats")).json();
const redis = async () => (await fetch("http://127.0.0.1:8082/stats")).json();

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function main() {
  await fetch("http://127.0.0.1:8081/reset", { method: "POST" });
  void webhookPump((n) => n * CALLS_PER_AGENT_PER_S, callWebhook);
  void webhookPump((n) => n * LEADS_PER_AGENT_PER_S, leadWebhook);
  const phaseQ = [];
  for (const ph of PHASES) {
    phaseName = `${ph.agents} agents`;
    const q0 = await qstash();
    for (let i = activeCount; i < ph.agents && i < agents.length; i++) {
      agents[i].active = true;
      void agentLoop(agents[i]);
      await sleep(10); // stagger logins a little
    }
    activeCount = ph.agents;
    console.log(`▶ ${phaseName} for ${ph.secs}s`);
    await sleep(ph.secs * 1000);
    const q1 = await qstash();
    phaseQ.push({ phase: phaseName, secs: ph.secs, messages: q1.published - q0.published, q: q1 });
  }
  running = false;
  await sleep(8000); // let in-flight jobs finish
  const qEnd = await qstash();
  const rEnd = await redis();

  const rows = [];
  for (const [key, s] of stats) {
    const [phase, kind] = key.split("|");
    const n = s.lat.length;
    const ok = Object.entries(s.codes).filter(([c]) => /^2|^3/.test(c)).reduce((x, [, v]) => x + v, 0);
    const secs = PHASES.find((p) => `${p.agents} agents` === phase)?.secs ?? 1;
    rows.push({ phase, kind, req: n, "req/s": (n / secs).toFixed(1), "err%": (((n - ok) / n) * 100).toFixed(1), p50: Math.round(pct(s.lat, 50)), p95: Math.round(pct(s.lat, 95)), p99: Math.round(pct(s.lat, 99)), max: Math.round(pct(s.lat, 100)), codes: JSON.stringify(s.codes) });
  }
  console.table(rows);
  console.table(phaseQ.map((p) => ({ phase: p.phase, "QStash msgs": p.messages, "msgs/min": ((p.messages / p.secs) * 60).toFixed(0), "→ per 8h day": Math.round((p.messages / p.secs) * 8 * 3600) })));
  console.log("QStash totals:", JSON.stringify({ published: qEnd.published, deduped: qEnd.deduped, delivered: qEnd.delivered, failed: qEnd.failed, backlogMax: qEnd.maxBacklog, statuses: qEnd.statuses, byJob: qEnd.byJob, jobLatencyMs: { p50: qEnd.p50, p95: qEnd.p95, p99: qEnd.p99, max: qEnd.max } }));
  console.log("Redis:", JSON.stringify(rEnd));
  process.exit(0);
}
main();
