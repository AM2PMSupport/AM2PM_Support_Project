# RULE — Non-negotiable rules for the AM2PM CRM

These rules apply to every change. A PR that breaks one is not merged. Why each exists is in [ARCHITECTURE.md](ARCHITECTURE.md) and [DESIGN.md](DESIGN.md).

## 1. Tenant isolation (non-negotiable)

1. Every tenant table has `tenant_id uuid not null` (FK → tenants), defaulting to `current_setting('app.tenant_id')`.
2. Every tenant table has row-level security enabled with the `tenant_isolation` policy for `app_rls` (`drizzle/0001_rls.sql`). A new tenant table ships with its policy in the same migration.
3. All tenant data access goes through `withTenant(ctx, fn)` (`lib/db/tenant.ts`), which sets `app.tenant_id` and `SET LOCAL ROLE app_rls` for that transaction. Never run tenant queries on the raw pool.
4. Importing `@/lib/db/client`, `pg` or `@/lib/platform-admin/db` is blocked by lint outside `lib/db/` and `lib/platform-admin/`.
5. Cross-tenant work (sweeps, Super Admin) lives only in `lib/platform-admin/`, and anything that changes one tenant's business data hands off to `withTenant()`. Super Admin reads are audit-logged.
6. Integration tests prove isolation on real Postgres (`tests/integration`). Every new API route adds a cross-tenant test: act as tenant A, assert zero tenant-B rows.
7. `tenantId` comes from the authenticated session or verified webhook URL — never from the request body.
8. Never set `app.tenant_id` or change role anywhere except `withTenant()`.
9. Restores re-check `tenant_id` on every row and refuse a snapshot from another tenant.

## 2. Data and database

1. **Never "find then insert" for dedupe.** Use `INSERT … ON CONFLICT … DO NOTHING RETURNING` against the unique index; no row back = duplicate. Don't catch unique violations inside a transaction: in Postgres the error aborts the whole transaction.
2. One transaction per business change. Lock rows you will change based on a read (`SELECT … FOR UPDATE`), as assignment does.
3. Any state change other systems care about writes an `outbox` row **in the same transaction**.
4. No HTTP calls (providers, QStash, webhooks) inside a database transaction. Commit first, then call out.
5. Relations are foreign keys; many-to-many uses a join table. JSONB is only for per-client shapes (custom fields, settings, payloads).
6. Snapshot small values (agent name, disposition label) into the row that needs history; the source of truth stays in one place.
7. Keyset pagination (`(created_at, id) < (…)`) — never `OFFSET` for queues or timelines.
8. Every new query has a supporting index starting with `tenant_id` (catalogue: DESIGN.md §2.5); check `EXPLAIN (ANALYZE)` on realistic volume, not a 3-row table. Text search uses the trigram indexes via `searchContacts()`; never `ILIKE '%…%'` on an unindexed column. Escape user input in LIKE patterns.
9. Dashboards read `daily_stats`, never raw `interactions`.
10. Store `timestamptz` (UTC); display in the tenant timezone.
11. Field keys, disposition codes and custom-field keys are immutable; only labels change. Deletes of definitions are soft.
12. Schema changes only via `lib/db/schema.ts` → `npm run db:generate` → reviewed SQL in `drizzle/` → `npm run db:migrate`. Never edit tables by hand in Neon.
13. One `pg` pool per function instance (`max: 10`, `attachDatabasePool`), on Neon's pooled URL. Only transaction-scoped settings (`set_config(…, true)`, `SET LOCAL`) — never session-level `SET`, because PgBouncer reuses connections.
14. Recordings and files never go in the database — store the Blob/R2 key only.
15. Pure reads (lists, dashboards, reports, exports) use `withTenantRead()` — read replica chosen by least connections, read-only, primary fallback. Anything that reads in order to write uses `withTenant()` on the primary; replicas lag.
16. Code must survive a database failover: no session-level state, idempotent jobs, and connection errors left to QStash retries.

## 3. Serverless and queues

1. Webhook routes do only: verify → insert `webhook_events` → publish to QStash → return 200. No business logic inline. Exception (2026-10-05, MEMORIE.md): **call** webhooks are processed right after the 200 via `after()` (`processNow`) because the agent's live stepper waits on them; still stored first, and a failure is queued to QStash for retries.
2. No function runs longer than ~60 s; fan out via QStash or save a cursor and re-queue.
3. Every job handler is **idempotent**: QStash delivers at least once and retries count as messages.
4. `/api/jobs/*` verifies the QStash signature; `/api/cron/*` verifies `CRON_SECRET`. Reject otherwise.
5. Cron routes run their (idempotent, time-boxed) job directly — they are the backup path that must work when QStash is out of quota or down (2026-10-05, MEMORIE.md). Each job stays under the 60 s function limit; anything bigger fans out through QStash as before.
6. No long-running listeners (change streams, WebSocket servers, BullMQ). Use outbox + QStash + SSE.
7. Redis holds only rebuildable state. Never the only copy of any record.

## 4. Assignment

1. The pick is atomic, in one transaction: lock the lead and the process's `assignment_state` (`FOR UPDATE`), then `UPDATE users SET open_leads = open_leads + 1 WHERE id = $1 AND open_leads < max_open_leads RETURNING`; no row = try the next candidate, up to 3.
2. Percentage/Ratio must interleave (smooth weighted round-robin). Contiguous blocks are a bug.
3. Eligibility order is fixed: active → mapped → available (and not on approved Jibble leave today, T2.25) → working hours → capacity → quota → skills.
4. `open_leads` decrements on won, lost, DNC and reassignment; the nightly `recount-open-leads` job corrects drift.

## 5. Security and privacy

1. Provider credentials and webhook secrets are AES-256-GCM encrypted (key in Vercel env) and **never returned** by any API.
2. Secrets and source keys are shown once at creation; store only hashes where possible.
3. Phone numbers are masked for roles without unmask permission — in UI, API responses and CSV exports.
4. Recordings are served only through short-lived signed URLs; every play and every export writes `audit_logs`.
5. No outreach (WhatsApp, email, SMS campaigns) without `contacts.consent` for that channel; DNC blocks everything.
6. Outbound webhooks: HTTPS only; signed `X-AM2PM-Signature`; stable event `id`.
7. Full-backup download needs a fresh TOTP, a 15-minute signed URL, and emails all tenant admins.
8. Restores follow the two-person rule: requester ≠ approver.
9. No secrets, tokens or real customer PII in code, tests, logs, fixtures or commits. Use `.env.local` (git-ignored).
10. Logs never contain full phone numbers, emails, message bodies or credentials.

## 6. Integrations

1. Providers are called only through adapters in `lib/providers/*`; the app never calls a provider URL directly.
2. CallerDesk DIDs are sent exactly as registered (leading 0 kept) — port `canonicalDid`.
3. CallerDesk caller-leg recovery (`resolveCustomerPhone_`) is ported as-is, with tests from real payload samples.
4. Respect provider rate limits via Redis; bulk sends are chunked through QStash.

### 6.1 Telephony: click-to-call only
1. **No SIP.** No SIP trunks, SIP/PBX servers, WebRTC, softphones, browser audio or media streams. Voice is carried only by the provider between phones.
2. Outbound calls are placed only through the adapter's `clickToCall` REST call; inbound and outbound call state comes only from provider webhooks.
3. No auto-dialling: one agent click = one call. Predictive, parallel or unattended dialling is not built.
4. Create the `interactions` row (`initiated`, `correlationId`) **before** calling the provider API, so every webhook can be matched.
5. One live call per agent: `SET call:active:{userId} NX` before the API call; release on a terminal webhook, on API failure, or by the stuck-call sweeper.
6. Block the call if the contact is DNC, the agent has no verified `agentPhone` or DID, or the lead is outside the agent's scope.
7. Every inbound DID maps to exactly one process; a webhook for an unknown DID is stored as `failed` and alerts the admin, never guessed.
8. Call webhook handlers are idempotent on `{provider, providerCallId, event kind}`; out-of-order webhooks never move a call backwards (e.g. `completed` is final).
9. Recordings are copied from the provider URL to Blob/R2 by a worker; the provider URL is never shown to users.
10. Phone numbers sent to a provider use that provider's format (CallerDesk: 10 digits, no country code); stored numbers are E.164.

## 7. Code quality

1. TypeScript `strict`; no `any` in domain code. Validate all external input with Zod at the boundary.
2. Business logic lives in `lib/` as pure, testable functions; route handlers stay thin.
3. Every bug fix and every domain rule (dedupe, assignment, signature, consent) has a unit test.
4. API errors return `{ error: { code, message } }` with correct HTTP status; never leak stack traces.
5. Money/time: no floating time math across timezones — use a tz-aware library with the tenant timezone.
6. Match the style of surrounding code; no unused exports; no commented-out code.
7. PRs: lint, typecheck and tests green; cross-tenant test updated for any new route.

## 8. Cost guardrails

1. Recordings in Blob/R2 only; recordings older than 30 days move to infrequent-access storage.
2. Retention (daily `purge-expired` job): `webhook_events` 60 d, `workflow_runs` and `webhook_deliveries` 90 d, `outbox` 30 d after publish.
3. Move Neon from Free to Launch (point-in-time restore) before the first paying client; add a read replica before adding a second database.
4. Any change that adds a paid service or raises monthly cost > $10 needs a note in [MEMORIE.md](MEMORIE.md).

## 9. Documentation

1. A change to data model, events, API or rules updates [DESIGN.md](DESIGN.md) / [RULE.md](RULE.md) in the same PR.
2. Decisions go in the decision log in [MEMORIE.md](MEMORIE.md) with date and reason.
3. Task status is kept current in [TASK.md](TASK.md).
