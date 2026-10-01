# AM2PM Call Center CRM

A multi-client call-center CRM for AM2PM Support. Calls are **click-to-call through a cloud telephony provider (no SIP)**, both inbound and outbound; agents talk on their own phones. It replaces the per-client Google Sheets CRM (`crmv7.gs`). Leads are imported automatically, deduplicated, and given to an agent within seconds. Outbound webhooks fire when leads convert. Each client can be backed up and restored on its own.

> **Status:** backend foundation in place (1 Oct 2026): data layer with tenant isolation, webhook intake, queue, lead dedupe, auto-assignment, outbox + signed webhooks, click-to-call telephony (inbound + outbound). Frontend screens are built and run on clearly-labelled sample data until sign-in lands (T1.11) — see [TASK.md](TASK.md).

## Stack

| Layer | Choice |
| --- | --- |
| App + API | Next.js (App Router, TypeScript) on Vercel |
| Database | Neon serverless Postgres (AWS Mumbai) via Vercel Marketplace; Drizzle ORM; row-level security per tenant |
| Queue / retries | Upstash QStash |
| Live state | Upstash Redis |
| Scheduled jobs | Vercel Cron → QStash |
| Files | Vercel Blob or Cloudflare R2; separate R2 bucket for backups |
| Auth | Auth.js (Google + email OTP, optional TOTP) |
| Telephony | CallerDesk API click-to-call + call webhooks, inbound and outbound; no SIP, PBX or WebRTC (MyOperator / Exotel adapters later) |
| Messaging | Interakt (WhatsApp), Brevo, Resend (email) |

Estimated cost: **~$20/month pilot, ~$70–75/month at 200 agents, ~$370–410/month at 2,000 agents** (provider charges excluded).

## Documentation

| File | What it holds |
| --- | --- |
| [PRD.md](PRD.md) | Problem, users, requirements, metrics, release plan, open decisions |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, flows, jobs, tenancy, security, backup, cost |
| [DESIGN.md](DESIGN.md) | Tables, relations, indexes, RLS, pipeline and assignment algorithms, events, API, screens, crmv7 mapping |
| [RULE.md](RULE.md) | Non-negotiable engineering and business rules |
| [TASK.md](TASK.md) | Phased task list with gates |
| [MEMORIE.md](MEMORIE.md) | Decision log, key numbers, crmv7 behaviours, glossary |
| [API.md](API.md) | Endpoints (live and planned), auth, errors, outbound webhook format and signature verification |
| [SECURITY.md](SECURITY.md) | Threat model, controls (enforced vs planned), secrets, DPDP, release checklist, how to report a vulnerability |
| [CODING_STANDARDS.md](CODING_STANDARDS.md) | Structure, naming, comments, errors, DB code, testing, git conventions |
| [CLAUDE.md](CLAUDE.md) | Instructions for Claude Code in this repo |
| `Docs/` | Source design doc (.docx) and architecture deck (.pptx) |

## Repository layout

Each folder owns one concern, so the project scales by **adding** folders and files, not by editing shared ones.

```
app/
  login/                                      sign-in (Auth.js in T1.11)
  (app)/console · leads · dashboard · admin   agent console, leads + search, Floor dashboard, Setup — preview on sample data
  globals.css                                 design tokens (paper/ink, brand teal + orange)
  api/hooks/[tenant]/[source]/route.ts        lead-source webhooks: verify key → store → queue
  api/hooks/[tenant]/telephony/[provider]/    call webhooks (inbound + outbound), no SIP
  api/v1/leads/[id]/call/route.ts             agent Call button → click-to-call
  api/jobs/[job]/route.ts                     QStash consumers (signature-verified)
  api/cron/[job]/route.ts                     Vercel Cron → enqueue job (CRON_SECRET)
components/            shell (rail, top bar, IST clock) · console (call control, outcomes, SLA ring) · dashboard charts · leads table · ui primitives
lib/
  config/env.ts        validated env vars, parsed per group on first use
  db/                  schema.ts (tables, FKs, indexes) · client.ts (primary + replica pools) · tenant.ts (withTenant, withTenantRead + RLS) · least-connections.ts
  tenancy/             TenantContext — where tenantId comes from
  platform-admin/      the ONLY cross-tenant code: tenant lookup, sweeps, retention purge
  auth/                session → TenantContext (Auth.js in T1.11)
  crypto/              AES-256-GCM, HMAC, SHA-256
  queue/               job catalogue + QStash publish/verify
  redis/               Upstash client + key names
  phone/               phoneKey, E.164, DID rules from crmv7
  leads/               normalise, create-or-merge (dedupe via ON CONFLICT), search (trigram indexes)
  assignment/          pure pick methods, eligibility, atomic assign
  events/              catalogue, outbox, signature, delivery
  webhooks/            intake: store + queue
  jobs/                job handlers
  telephony/           adapter contract, state machine, click-to-call, call events, call lock
  providers/telephony/callerdesk/   CallerDesk adapter
  http/errors.ts       API error shape
  log.ts               JSON logs with PII redaction
drizzle/               SQL migrations: 0000_init (tables, FKs, indexes), 0001_rls (row-level security), 0002 search extensions, 0003 search + call indexes
scripts/db-migrate.ts  apply migrations
tests/                 unit tests (pure logic) + integration tests on real Postgres via PGlite (RLS, dedupe, assignment, calls)
vercel.json            cron schedules
```

## How to extend (scaling the codebase)

| To add… | Do this |
| --- | --- |
| A telephony provider (MyOperator, Exotel) | New `lib/providers/telephony/<name>/adapter.ts` implementing `TelephonyAdapter`; one line in `lib/telephony/registry.ts` |
| A background job | Add name + payload to `lib/queue/jobs.ts`; add handler in `lib/jobs/handlers.ts` (idempotent, < 60 s) |
| A scheduled job | Job as above + entry in `vercel.json` + name in `CRON_JOBS` in `app/api/cron/[job]/route.ts` |
| An outbound event | Add to `lib/events/catalogue.ts`; call `writeOutbox(...)` in the same transaction as the change |
| A table | Define it in `lib/db/schema.ts` (with `tenantId()` and indexes starting with it) → `npm run db:generate` → add its RLS policy in a new SQL migration → `npm run db:migrate` → integration test |
| An assignment method | Pure function in `lib/assignment/methods.ts` + case in `pick()` + test |
| A lead source | Field map on the `import_sources` document; source-specific fetch (e.g. Meta Graph API) in `lib/jobs/process-webhook.ts` |
| A dedicated database for a big client | Separate Neon project + a per-tenant connection resolver in `lib/db/client.ts` (not built yet) |

## Getting started

```bash
npm install
vercel link                    # link to the Vercel project
vercel env pull .env.local     # Neon, Upstash, Blob vars from Marketplace integrations
npm run db:migrate             # apply drizzle/ migrations (tables + RLS)
npm run dev                    # http://localhost:3000
npm test                       # unit + Postgres integration tests (no setup needed)
npm run lint && npm run typecheck && npm run build
```

QStash can't call `localhost`. Run jobs locally with the QStash local dev server, or tunnel with `ngrok` and set `APP_URL` to the tunnel URL.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon pooled connection string (runtime) |
| `DATABASE_URL_UNPOOLED` | Neon direct connection string (migrations) |
| `DATABASE_REPLICA_URLS` | Optional Neon read replicas, comma-separated; reads route by least connections |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Publish jobs; verify `/api/jobs/*` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Live state, caches, rate limits |
| `BLOB_READ_WRITE_TOKEN` or `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Recordings, uploads |
| `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_R2_BUCKET` | Separate backup store |
| `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Auth.js (T1.11) |
| `MASTER_ENCRYPTION_KEY` | AES-256-GCM for provider secrets and backup data keys |
| `CRON_SECRET` | Protects `/api/cron/*` |
| `APP_URL` | Base URL for webhooks and links |

Never commit `.env*` files.

## Roadmap

| Phase | Weeks | Gate |
| --- | --- | --- |
| 1 · Core | 1–6 | Pilot process matches sheet counts for 14 days |
| 2 · Automation | 7–10 | Signed `lead.converted` verified by a client |
| 3 · Reporting & portal | 11–14 | All clients off Sheets |
| 4 · Later | 15+ | LMS, attendance, invoicing, auto-next click-to-call, MyOperator/Exotel, AI QA |
