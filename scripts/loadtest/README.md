# Load test (simulated agents + provider webhooks)

Runs against an **isolated** stack — never production, never the real (free-plan) QStash / Redis:

| Piece | What |
| --- | --- |
| Database | a throw-away Neon branch (`neonctl branches create`), deleted afterwards |
| QStash, Redis | `fake-services.mjs` — local stand-ins (counts QStash messages, signs deliveries like QStash) |
| App | `next start` ×4 on ports 3101–3104 behind the round-robin LB on :3200 |
| Load | `run.mjs` — agents call the real console server actions; CallerDesk + lead webhooks |

## Steps

1. `npx neonctl branches create --project-id <id> --name loadtest-<date>`; write its pooled + direct URLs into a private env file (mode 600) — take the password from `.env.local`, only swap the host. **Never print connection strings.**
2. Seed: `LT_ALLOW_SEED=1 LT_BRANCH_HOST=<branch endpoint id> LT_OUT=<private>/seed.json node --env-file=<branch env + MASTER_ENCRYPTION_KEY, AUTH_SECRET, CRON_SECRET> --import tsx scripts/loadtest/seed.ts 250 2`
3. `npm run build`; start `node scripts/loadtest/fake-services.mjs` (env `LT_SIGNING_KEY`, `LT_APP_PORTS=3101,3102,3103,3104`) and four `next start -p 310x` with an env file that points `DATABASE_URL*` at the branch, `QSTASH_URL=http://127.0.0.1:8081`, `UPSTASH_REDIS_REST_URL=http://127.0.0.1:8082`, `APP_URL=http://localhost:3200`, empty `DATABASE_REPLICA_URLS`, `BLOB_READ_WRITE_TOKEN`, `RESEND_API_KEY`.
4. `node scripts/loadtest/run.mjs <seed.json> --smoke`, then without `--smoke` (50 → 150 → 300 → 500 agents, ~6 min).
5. Stop everything, `neonctl branches delete loadtest-<date>`, delete the seed/env files.

**Run it from the same region as the database** (a Singapore VM or a Vercel preview of this stack) to measure the database itself: from a laptop in India every round trip to Neon Singapore costs ~90 ms and the connection pool, not the database, becomes the limit (results 2026-10-05 in MEMORIE.md).
