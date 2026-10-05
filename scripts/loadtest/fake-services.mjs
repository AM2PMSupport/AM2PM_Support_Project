/**
 * Load test — local stand-ins so a test never touches the real (free-plan)
 * services:
 *
 *   :8081  QStash  — accepts `publish`, counts every message (the number the
 *                    free plan caps at 1,000/day), then delivers it to the app
 *                    with a real HS256 Upstash-Signature (iss Upstash, sub =
 *                    URL, body = sha256), honouring delay, dedupe id and a
 *                    parallelism cap. GET /stats → counters + delivery latency.
 *   :8082  Redis   — Upstash REST protocol (single command + /pipeline,
 *                    base64 response encoding) for the commands the app uses.
 *   :3200  LB      — round-robin proxy over the app instances (like Vercel
 *                    running several copies), keeping the Host header so
 *                    QStash signatures (sub = URL) still verify.
 *
 * Env: LT_SIGNING_KEY, LT_APP_PORTS=3101,3102,…, LT_QSTASH_PARALLEL (default 100).
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const KEY = new TextEncoder().encode(process.env.LT_SIGNING_KEY ?? "lt-signing-key");
const PORTS = (process.env.LT_APP_PORTS ?? "3101").split(",").map(Number);
const PARALLEL = Number(process.env.LT_QSTASH_PARALLEL ?? 100);

const readBody = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);

// ── QStash ────────────────────────────────────────────────────────────────
const q = { published: 0, deduped: 0, delivered: 0, failed: 0, byJob: {}, latency: [], queued: [], active: 0, maxBacklog: 0, statuses: {} };
const seen = new Map(); // dedupe id → expiry

let qrr = 0;
async function deliver(msg) {
  q.active++;
  const started = Date.now();
  try {
    // Deliver straight to an instance: `next start` sees its OWN port in req.url,
    // so the signature's subject must name that URL (on Vercel both are the public URL).
    const target = msg.url.replace(/:\/\/[^/]+/, `://localhost:${PORTS[qrr++ % PORTS.length]}`);
    const bodyHash = createHash("sha256").update(msg.body).digest("base64url");
    const jwt = await new SignJWT({ body: bodyHash })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("Upstash").setSubject(target).setIssuedAt().setNotBefore("0s").setExpirationTime("5m").setJti(randomUUID())
      .sign(KEY);
    const res = await fetch(target, { method: "POST", body: msg.body, headers: { "content-type": "application/json", "upstash-signature": jwt } });
    await res.arrayBuffer();
    q.statuses[res.status] = (q.statuses[res.status] ?? 0) + 1;
    if (res.ok) {
      q.delivered++;
      q.latency.push(Date.now() - msg.publishedAt);
    } else if (msg.retries-- > 0) {
      setTimeout(() => enqueue(msg), 1000); // QStash backs off and retries; each retry is a billed message
      q.published++;
    } else q.failed++;
  } catch {
    if (msg.retries-- > 0) { setTimeout(() => enqueue(msg), 1000); q.published++; } else q.failed++;
  } finally {
    q.active--;
    pump();
  }
  return Date.now() - started;
}
function enqueue(msg) { q.queued.push(msg); q.maxBacklog = Math.max(q.maxBacklog, q.queued.length); pump(); }
function pump() { while (q.active < PARALLEL && q.queued.length) void deliver(q.queued.shift()); }

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/stats") {
    res.end(JSON.stringify({ ...q, latency: undefined, queued: q.queued.length, p50: pct(q.latency, 50), p95: pct(q.latency, 95), p99: pct(q.latency, 99), max: pct(q.latency, 100) }));
    return;
  }
  if (req.method === "POST" && req.url === "/reset") { Object.assign(q, { published: 0, deduped: 0, delivered: 0, failed: 0, byJob: {}, latency: [], maxBacklog: 0, statuses: {} }); res.end("{}"); return; }
  const m = /^\/v2\/publish\/(.+)$/.exec(req.url ?? "");
  if (req.method !== "POST" || !m) { res.statusCode = 404; res.end("{}"); return; }
  const body = await readBody(req);
  const url = decodeURIComponent(m[1]);
  const dedupe = req.headers["upstash-deduplication-id"];
  const now = Date.now();
  if (dedupe && (seen.get(dedupe) ?? 0) > now) { q.deduped++; res.end(JSON.stringify({ messageId: "dup", deduplicated: true })); return; }
  if (dedupe) seen.set(dedupe, now + 600_000);
  q.published++;
  const job = url.split("/api/jobs/")[1] ?? "?";
  q.byJob[job] = (q.byJob[job] ?? 0) + 1;
  const delay = Number(String(req.headers["upstash-delay"] ?? "0").replace("s", "")) || 0;
  const msg = { url, body, publishedAt: now, retries: Number(req.headers["upstash-retries"] ?? 3) };
  if (delay > 0) setTimeout(() => enqueue(msg), delay * 1000); else enqueue(msg);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ messageId: randomUUID() }));
}).listen(8081, () => console.log("fake QStash :8081"));

// ── Redis (Upstash REST) ──────────────────────────────────────────────────
const store = new Map(); // key → { v, exp }
let redisCommands = 0;
const live = (k) => { const e = store.get(k); if (!e) return undefined; if (e.exp && e.exp < Date.now()) { store.delete(k); return undefined; } return e; };
function run(cmd) {
  redisCommands++;
  const [name, ...a] = cmd.map(String);
  switch (name.toLowerCase()) {
    case "ping": return "PONG";
    case "get": return live(a[0])?.v ?? null;
    case "mget": return a.map((k) => live(k)?.v ?? null);
    case "set": {
      const [k, v, ...opt] = a; const o = opt.map((x) => x.toLowerCase());
      if (o.includes("nx") && live(k)) return null;
      let exp = 0; const ex = o.indexOf("ex"), px = o.indexOf("px");
      if (ex >= 0) exp = Date.now() + Number(opt[ex + 1]) * 1000;
      if (px >= 0) exp = Date.now() + Number(opt[px + 1]);
      store.set(k, { v, exp }); return "OK";
    }
    case "del": return a.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0);
    case "incr": { const e = live(a[0]); const n = Number(e?.v ?? 0) + 1; store.set(a[0], { v: String(n), exp: e?.exp ?? 0 }); return n; }
    case "expire": { const e = live(a[0]); if (!e) return 0; e.exp = Date.now() + Number(a[1]) * 1000; return 1; }
    case "exists": return a.filter((k) => live(k)).length;
    default: throw new Error(`fake redis: unsupported ${name}`);
  }
}
const enc = (v, b64) => (b64 && typeof v === "string" ? Buffer.from(v).toString("base64") : Array.isArray(v) ? v.map((x) => enc(x, b64)) : v);

http.createServer(async (req, res) => {
  const b64 = String(req.headers["upstash-encoding"] ?? "").toLowerCase() === "base64";
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/stats") { res.end(JSON.stringify({ commands: redisCommands, keys: store.size })); return; }
  const body = JSON.parse((await readBody(req)).toString() || "[]");
  const one = (c) => { try { return { result: enc(run(c), b64) }; } catch (e) { return { error: String(e.message) }; } };
  if (req.url?.startsWith("/pipeline") || req.url?.startsWith("/multi-exec")) res.end(JSON.stringify(body.map(one)));
  else res.end(JSON.stringify(one(body)));
}).listen(8082, () => console.log("fake Redis :8082"));

// ── Load balancer ─────────────────────────────────────────────────────────
let rr = 0;
http.createServer((req, res) => {
  const port = PORTS[rr++ % PORTS.length];
  const up = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => { res.statusCode = 502; res.end(); });
  req.pipe(up);
}).listen(3200, () => console.log(`LB :3200 → ${PORTS.join(",")}`));
