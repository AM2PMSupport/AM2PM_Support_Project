# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

AM2PM Call Center CRM: a multi-client BPO CRM that replaces the per-client Google Sheets CRM (`crmv7.gs`). Calls, inbound and outbound, go through the provider's click-to-call API and webhooks; there is no SIP. Stack: Next.js on Vercel, Neon Postgres (Drizzle ORM, row-level security), Upstash QStash + Redis, Vercel Cron, Blob/R2, Auth.js. The product is in [PRD.md](PRD.md) and the system shape in [ARCHITECTURE.md](ARCHITECTURE.md).

**Progress tracking:** [WORKPHASE.md](WORKPHASE.md) is the owner's view of what is built in which phase; [TASK.md](TASK.md) holds the task specs. Whenever a task starts, finishes, is added (new owner request) or dropped, update BOTH in the same change, plus WORKPHASE's Overview, "Next up", "Added during the build" and Update log. `tests/workphase.test.ts` fails if they disagree.

**Current state:** live on Vercel + Neon. Email/password sign-in with one login per person and a Zoho-style workspace switcher (SECURITY.md §3.1); Console, Leads (filters, saved filters, board, bulk actions), Floor, Reports (`/reports`: overview, agents, sources, calls & callbacks), Attendance (`/attendance`, from Jibble — needs the owner's key) and Setup (searchable grid) run on real data; "Soon" (`/soon`) showcases planned modules on sample data (`lib/ui/coming-soon.ts`). Unfinished work is marked `TODO(T<id>)` in code and `[~]` in [TASK.md](TASK.md). Keep both current.

## Read before changing code

| When you touch… | Read first |
| --- | --- |
| Anything | [RULE.md](RULE.md) — the non-negotiables |
| Tables, relations, RLS, API, events, screens | [DESIGN.md](DESIGN.md) and `lib/db/schema.ts` |
| Flows, jobs, backup, security, cost | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Why something is the way it is | [MEMORIE.md](MEMORIE.md) decision log |
| An API route, webhook or the GraphQL schema | [API.md](API.md) — update it in the same change. `tests/api-docs.test.ts` fails the build if a route/method is undocumented or §6.2 differs from `lib/graphql/schema.ts` |
| Auth, secrets, isolation, PII | [SECURITY.md](SECURITY.md) |
| Style, naming, structure, tests | [CODING_STANDARDS.md](CODING_STANDARDS.md) |

`Docs/*.docx` and `Docs/*.pptx` are the source design; the markdown files are derived from them. If they disagree, the .docx (v1.1) wins, and you should flag it. The exception is later decisions in the [MEMORIE.md](MEMORIE.md) decision log, such as the 2026-10-01 click-to-call-only telephony decision; those take precedence.

## Commands

```bash
npm run dev          # local app
npm test             # unit + integration tests (Postgres via PGlite, no setup)
npm run lint         # eslint, incl. the raw-DB import ban
npm run typecheck
npm run build
npm run db:generate  # SQL migration from lib/db/schema.ts changes
npm run db:migrate   # apply drizzle/ migrations (needs .env.local)
```

Run lint, typecheck and the relevant tests before calling work done. Report failures as they are.

## Rules Claude must follow here

1. **Tenant isolation first.** Do all tenant data access inside `withTenant(ctx, tx => …)` from `lib/db/tenant.ts` (it switches to the RLS-bound `app_rls` role). Never use the raw pool outside `lib/db` / `lib/platform-admin`. Every new tenant table needs `tenantId()` and an RLS policy migration. Take `tenantId` from the session or the verified webhook URL, never from the body. Add a cross-tenant test for every new route.
2. **Webhook routes only verify → store in `webhook_events` → publish to QStash → 200.** Put business logic in `/api/jobs/*` handlers, and make them idempotent.
3. **Dedupe with `INSERT … ON CONFLICT DO NOTHING RETURNING`.** Never find-then-insert, and never catch unique violations inside a transaction (Postgres aborts it).
4. **State changes other systems care about write an `outbox` row in the same transaction.**
5. **Assignment is atomic** (`FOR UPDATE` on lead + assignment_state, conditional `open_leads` increment, retry ≤ 3). Percentage/Ratio must interleave.
6. **No long-running processes.** No change streams, WebSocket servers or BullMQ; stay under ~60 s per function, fan out via QStash.
7. **Writes on the primary via `withTenant`; pure reads via `withTenantRead`** (replicas by least connections, primary fallback). **One `pg` pool per target per instance** (max 10, pooled Neon URL, `attachDatabasePool`); only transaction-scoped settings. No HTTP calls inside a transaction.
8. **Every query has an index starting with `tenantId`.** Use cursor pagination, never `skip`.
9. **Secrets are never returned by the API, logged or committed.** Mask phone numbers by role. Keep PII out of logs and fixtures.
10. **Providers only through `lib/providers/*` adapters.** Keep the CallerDesk DID's leading 0.
11. **Telephony is API click-to-call only — never add SIP, PBX, WebRTC, softphone or browser audio code.** Outbound = adapter `clickToCall` (agent phone rings first); inbound and outbound state = provider webhooks only. Create the `initiated` interaction before the API call, hold the `call:active:{userId}` lock, and never auto-dial. See [RULE.md §6.1](RULE.md#61-telephony-click-to-call-only) and [DESIGN.md §5](DESIGN.md#5-telephony-click-to-call-no-sip).
12. **Dates:** store UTC and display in the tenant timezone.
13. When you change the data model, events, API or rules, update DESIGN.md / RULE.md in the same change. Record decisions in MEMORIE.md with the date.

## Conventions

- Every file starts with a header comment: what it does, why, and the DESIGN/RULE section it implements. Comment the *why* (rules, races, provider quirks), not what the code obviously does.
- Unfinished work = `TODO(T<task id>): …` so it is findable from TASK.md.
- Pure logic (methods, state machines, normalisers, signatures) lives in its own file with no I/O and has unit tests.

- TypeScript strict; Zod at every external boundary; no `any` in domain code.
- Business logic in `lib/` as pure functions with unit tests; route handlers stay thin.
- API errors: `{ error: { code, message } }`; lists: `{ items, nextCursor }`.
- File names kebab-case; tables and columns snake_case in SQL, camelCase in TypeScript (Drizzle maps them).
- Commit messages reference task IDs (e.g. `T1.21 dedupe insert with merge on conflict`).
- Match the surrounding code's style and comment density; no speculative abstractions.

## Porting from crmv7

The Apps Script source is not in this folder; see [MEMORIE.md §6](MEMORIE.md#6-crmv7-behaviours-to-preserve) for behaviour to keep. Ask the owner for `crmv7.gs` before porting a function line by line (e.g. `resolveCustomerPhone_`, `canonicalDid`, report builders).

## Doing setup work (owner's standing instruction, 2026-10-01)

**Do infrastructure and setup tasks yourself with the CLIs** — don't hand the owner click-through steps. The Vercel CLI is installed and logged in (team `am2pm-projects`, project `am2pm_support_project`, already linked).

- Provision / connect / inspect with `vercel integration …`, `vercel integration-resource …`, `vercel api …`, `vercel env …`, `vercel deploy`.
- Provider-specific work (e.g. Neon read replicas) via the provider CLI through `npx` (e.g. `npx neonctl`).
- Only ask the owner when a step truly needs them: a browser OAuth approval, a billing approval, or a secret only they hold — and ask for that one action only.
- Never print secrets: write them straight into `.env.local` and Vercel env vars.
- Never commit or display `PASSWORD.md` (seeded role logins; git-ignored, mode 600).

## Vercel specifics

- Provision Neon, Upstash and Blob through the Vercel Marketplace so env vars are injected; pull with `vercel env pull .env.local`.
- Crons are declared in `vercel.json` and protected with `CRON_SECRET`.
- Use Fluid compute defaults; don't assume in-memory state survives between invocations.

## Don't

- Don't add paid services, change the database or the queue without a MEMORIE.md decision entry.
- Don't store recordings or files in the database.
- Don't edit tables by hand in Neon — change `lib/db/schema.ts`, run `npm run db:generate`, review the SQL.
- Don't send WhatsApp/email to contacts without channel consent; DNC blocks everything.
- Don't run destructive DB commands against shared or production clusters.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
