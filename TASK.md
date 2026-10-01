# TASK — Build plan

14 weeks, 2 full-stack developers, a gate at the end of each phase. IDs are stable; reference them in commits and PRs (`T1.12`). Scope source: [PRD.md §8](PRD.md#8-release-plan).

Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` dropped

**Infra live 2026-10-01: Neon (Singapore) + read replica `replica-1`, QStash, dedicated Redis `am2pm-crm-redis` (Mumbai); `/api/health` all green. T0.2 still needs Pro + Git connection; T3.16 still needs dashboard queries moved to `withTenantRead()`.**

**Code foundation landed 2026-10-01; database moved to Neon Postgres the same day; read-replica routing (least connections + failover) added the same day — replicas themselves are T3.16.** `[~]` items have code with a `TODO(Tx.y)` comment marking what is left; grep for the task id to find it. Open items inside those:
- T1.1: Tailwind + shadcn/ui and Playwright not added yet.
- T1.6: done for current tables; add the planned tables (import_batches, workflows, daily_stats, backup_*) with their RLS policies as they are built.
- **Hobby plan (temporary, 2026-10-01):** the Vercel team is on Hobby, which allows only daily crons, so `vercel.json` runs relay-outbox, sweep-unassigned and sweep-stuck-calls once a day. After upgrading to Pro, restore `* * * * *`, `*/5 * * * *`, `*/5 * * * *` (T3.15).
- T1.9: 5 crons so far (outbox relay, unassigned sweeper, stuck-call sweeper, retention purge, open-leads recount).
- T1.21: owner alert on merge.
- T1.28: Redis cache of eligible agents.
- T1.31: supervisor SLA alert.
- T1.37a: CallerDesk parameter and webhook field names must be checked against real payloads (T0.7, T0.9).
- T1.37d, T1.38a: screen-pop and live status need the SSE stream (T1.40).
- T2.10: email to admins when a subscription auto-pauses.
- T1.33–T1.35: screens built (console queue, lead workspace, call control, outcomes with callback picks) on sample data; need sign-in (T1.11) + read/write APIs to go live. Leads, Floor and Setup screens are also built (preview).

## Phase 0 — Decisions and setup (before week 1)

- [ ] T0.1 Close open decisions in [PRD.md §10](PRD.md#10-open-decisions) (volumes, live sources, `lead.converted` receivers, CallerDesk fallback, retention, build team)
- [~] T0.2 Create Vercel team + project (Pro plan); connect Git repo
- [x] T0.3 Provision Neon Postgres via Vercel Marketplace, region AWS Mumbai (ap-south-1); Free plan for dev/pilot; run `npm run db:migrate`
- [x] T0.4 Provision Upstash QStash + Redis via Vercel Marketplace
- [ ] T0.5 Create Vercel Blob store (or R2 bucket) for recordings/CSVs; separate R2 account + bucket (versioning, object lock) for backups
- [x] T0.6 Pull env vars locally (`vercel env pull .env.local`); document all vars in README
- [ ] T0.7 Collect sample payloads: CallerDesk click-to-call responses (success + each error), outbound and inbound call webhooks (start, answer, call_report, missed, recording), Interakt, Brevo, Resend, Meta leadgen
- [ ] T0.9 Confirm with CallerDesk: click-to-call API params, webhook events and signing, custom/correlation field support, inbound routing options (sticky agent, routing-lookup URL), recording URL lifetime
- [ ] T0.10 List every client DID with its process and direction; list agent phone numbers
- [ ] T0.8 Export 2–3 real crmv7 spreadsheets (anonymised) as migration fixtures

## Phase 1 — Core (weeks 1–6)

### Foundation
- [~] T1.1 Scaffold Next.js (App Router, TS strict), Tailwind + shadcn/ui, ESLint, Prettier, Vitest, Playwright
- [x] T1.2 `lib/db/client.ts`: one `pg` pool (max 10) on Neon's pooled URL, Drizzle, `attachDatabasePool`
- [x] T1.3 `lib/db/tenant.ts`: `withTenant()` — transaction + `app.tenant_id` + `SET LOCAL ROLE app_rls`; row-level security in `drizzle/0001_rls.sql`
- [x] T1.4 Lint rule banning the raw pool / `pg` / platform db outside `lib/db` and `lib/platform-admin`
- [x] T1.5 Cross-tenant test harness (seed tenants A/B; helper to assert no leakage per route)
- [~] T1.6 Drizzle schema + SQL migrations (tables, FKs, indexes, RLS) + `npm run db:migrate`
- [x] T1.7 `lib/crypto`: AES-256-GCM encrypt/decrypt, HMAC sign/verify, SHA-256 helpers
- [x] T1.8 `lib/queue`: QStash publish helper + `/api/jobs/*` signature verification
- [~] T1.9 `/api/cron/*` with `CRON_SECRET`; `vercel.json` cron schedule
- [x] T1.10 Structured logging with PII redaction

### Tenancy, auth, users
- [ ] T1.11 Auth.js: Google + email OTP; sessions hashed with expiry; role in session
- [ ] T1.12 Tenants CRUD (Super Admin); tenant settings (timezone, hours, retention)
- [ ] T1.13 Users + teams CRUD; roster fields (shareWeight, did, skills, maxOpenLeads, dailyQuota)
- [ ] T1.14 RBAC: scope resolver (own/team/process/tenant/global) + permission matrix from DESIGN §7
- [ ] T1.15 Phone masking serializer by role
- [ ] T1.16 `audit_logs` writer (insert-only DB user)

### Processes and leads
- [ ] T1.17 Processes CRUD: stages, wonStage, dedupe rule, assignment config
- [ ] T1.18 Dispositions CRUD with categories + actions; seed crmv7 defaults
- [ ] T1.19 Custom field definitions + write-path validation + `custom` object
- [~] T1.20 Contacts + leads model; `phoneKey` normaliser (port `toTenDigits`, `isValidMobile10`, `phoneKey`)
- [~] T1.21 Dedupe insert with `ON CONFLICT DO NOTHING` → merge; `lead_events`; `is_active` + re-enquiry window
- [x] T1.22 Outbox writer (same transaction) + relay (post-commit publish + 1-min sweep)

### Import
- [ ] T1.23 Import sources CRUD, field-map editor, source key shown once (stored hashed)
- [x] T1.24 Webhook API `/api/hooks/{tenant}/{sourceId}` → `webhook_events` → QStash
- [x] T1.25 Web-form source handler
- [ ] T1.26 CSV/Excel upload → Blob → 500-row QStash batches → batch report + error file
- [ ] T1.27 Google Sheet pull every 15 min with cursor (migration bridge)

### Assignment
- [~] T1.28 Eligibility filter + Redis cache (30 s)
- [x] T1.29 Equal, Percentage, Ratio (smooth weighted RR), Number (daily quota)
- [x] T1.30 Atomic pick transaction + retry ≤ 3; `lead.assigned` outbox
- [~] T1.31 Assignment sweeper cron (5 min) + SLA alert
- [x] T1.32 Nightly `open_leads` recount (`recount-open-leads` cron)

### Agent workspace and telephony
- [~] T1.33 My queue (callbacks due → fresh → recycled); availability toggle
- [~] T1.34 Lead workspace: contact card, custom fields, timeline, stage change
- [~] T1.35 Disposition + sub-disposition form; required before next call; callback quick picks
- [ ] T1.36 Callbacks model + reminder cron (5 min): notify 15 min before, missed, escalate at 30 min
- [x] T1.37 `TelephonyAdapter` interface + normalised call events (DESIGN §5.1)
- [~] T1.37a CallerDesk adapter `clickToCall` (10-digit numbers, `canonicalDid`, error mapping to plain messages)
- [ ] T1.37b Agent phone + DID on users; "Verify" test call; telephony admin screen (credentials, DIDs → process/direction, webhook URL)
- [x] T1.37c `POST /api/v1/leads/{id}/call`: access + DNC + `call:active` lock → `initiated` interaction → adapter → provider call id
- [~] T1.37d Outbound state machine from webhooks (initiated → … → completed); attempts; presence On call / Wrap-up; disposition required after end
- [~] T1.38 Telephony webhook route `/api/hooks/{tenant}/telephony/{provider}`; CallerDesk `verifyWebhook` + `parseWebhook`; port `resolveCustomerPhone_` + caller-leg cache (Redis)
- [~] T1.38a Inbound: DID → process, find/create contact + lead, interaction, screen-pop to answering agent (match `agentPhone`)
- [x] T1.38b Missed inbound: missed interaction, callback due now (owner or next eligible), one per number per day, `call.missed`
- [x] T1.38c Stuck-call sweeper (5 min): `initiated` > 10 min → `unknown`, release locks, alert on silent provider
- [ ] T1.39 Recording copy to Blob/R2 + signed URL playback + audit
- [ ] T1.40 SSE `/api/v1/stream` (or 5 s poll of Redis counter) for new leads, inbound screen-pop and live call status
- [~] T1.47 Quick search: trigram + call-lookup indexes and `searchContacts()` done (on Neon); `GET /api/v1/search` + search box in the agent UI after sign-in
- [ ] T1.41 Conversion transaction (status won, converted_at, open_leads − 1, events)

### Notifications and backup
- [ ] T1.42 Email sender (Resend) + manager digest cron 09:00
- [ ] T1.43 Per-tenant backup worker: stream 5,000/batch, gzip, envelope AES-256-GCM, multipart to R2, cursor + re-queue, manifest
- [ ] T1.44 `backup_policies`, `backup_snapshots`; nightly cron 01:30; `backup.completed/failed` alerts

### Migration and gate
- [ ] T1.45 Migration script per spreadsheet: CRM_Calling, Marketing_Leads, CRM_WebhookLog, MissedCalls → tables; roster, dropdowns; Timeline History → `lead_events`; count reconciliation
- [ ] T1.46 Pilot: migrate one process; run in parallel with the sheet
- [ ] **Gate 1:** pilot process lead counts match the sheet daily for 14 days

## Phase 2 — Automation (weeks 7–10)

- [ ] T2.1 Meta Lead Ads: leadgen webhook + Graph API fetch; page connect flow per client
- [ ] T2.2 Google Ads lead-form webhook
- [ ] T2.3 IndiaMART connector (push or 15-min pull with cursor)
- [ ] T2.4 Justdial connector (push or 15-min pull with cursor)
- [ ] T2.5 Public API `POST /api/v1/leads` + tenant API keys
- [ ] T2.6 Load-based, Skill/language/city, Sticky owner methods
- [ ] T2.6a Optional inbound routing lookup (`/telephony/{provider}/route`) returning the lead owner's number, if CallerDesk supports it
- [ ] T2.7 Working hours + caps enforcement in eligibility; tests across timezones
- [ ] T2.8 Stale-lead recycle cron (hourly); "agent leaves" bulk return to pool
- [ ] T2.9 Webhook subscriptions CRUD, secret shown once, test-send
- [~] T2.10 Delivery worker: HMAC signature, QStash retries, `webhook_deliveries`, auto-pause after 24 h
- [ ] T2.11 Events: `lead.created`, `lead.assigned`, `disposition.set`, `lead.stage_changed`, `lead.converted`, `lead.lost`, `callback.missed`, `call.completed`, `call.missed`
- [ ] T2.12 Failed events screen + Replay (DLQ)
- [ ] T2.13 Workflow engine: trigger → conditions → actions; `workflow_runs`
- [ ] T2.14 Interakt adapter: template sync, send, status webhook, consent gate
- [ ] T2.15 Brevo adapter: campaigns to consented contacts, status webhook
- [ ] T2.16 Resend adapter: broadcasts + transactional, unsubscribe link
- [ ] T2.17 `contacts.consent` UI + DNC enforcement across all senders
- [ ] **Gate 2:** a signed `lead.converted` reaches a client system and is verified there

## Phase 3 — Reporting and portal (weeks 11–14)

- [ ] T3.1 Daily rollup cron 00:30 (`$merge` into `daily_stats`)
- [ ] T3.2 Dashboards: funnel, leaderboard, source performance, callback compliance, time to convert, win/loss, week/month/quarter comparisons, day-of-week, stale leads, overdue callbacks
- [ ] T3.3 CSV export (streamed; large → file + emailed link), masking by role, audit-logged
- [ ] T3.4 Agent weekly report cron (Mon 08:00)
- [ ] T3.5 Client portal: processes, masked leads, assigned reports
- [ ] T3.6 Audit log viewer
- [ ] T3.7 Backups page: snapshots, backup now, download (fresh TOTP + 15-min URL), export CSV
- [ ] T3.8 Restore: request → approve (two-person) → sandbox / selective / full; webhooks muted; `restore.completed`
- [ ] T3.9 Weekly prune + verify (random-tenant restore test); monthly backup status email
- [ ] T3.10 TOTP 2FA + IP allowlist for agents
- [ ] T3.11 Retention cron 02:00: recordings to cold tier, erasure requests (DPDP)
- [ ] T3.12 Vercel Firewall rate limits on `/api/hooks/*` and login
- [ ] T3.13 Move Neon to the Launch plan (point-in-time restore) + IP allow list; add a read replica for reports if needed
- [ ] T3.14 Migrate remaining clients; set Apps Script sheets read-only
- [ ] T3.15 Upgrade Vercel team to Pro (commercial use) and restore the 1-min / 5-min cron schedules in `vercel.json`
- [~] T3.16 Create 1–2 Neon read replicas; set `DATABASE_REPLICA_URLS` in Vercel; move dashboard/report/export queries to `withTenantRead()`
- [ ] T3.17 DR runbook + drill: restore latest backup into a Neon project in another region, repoint `DATABASE_URL`, measure RTO
- [ ] T3.18 Uptime monitor on `/api/health` (alert when `ok:false` or any replica out of rotation)
- [ ] **Gate 3:** all clients off Sheets; Apps Script read-only

## Phase 4 — Later (week 15+)

- [ ] T4.1 LMS / training-to-production gate
- [ ] T4.2 Attendance and shifts
- [ ] T4.3 Reimbursements
- [ ] T4.4 Billing plans, usage, invoices
- [ ] T4.5 MyOperator / Exotel click-to-call adapters + fallback integration
- [ ] T4.6 Auto-next: after a disposition, open the next queued lead and start click-to-call after a short, configurable countdown (still one API call per click-equivalent; no SIP, no predictive dialling)
- [ ] T4.7 AI call QA
- [ ] T4.8 Postgres LISTEN/NOTIFY or logical replication for near-instant fan-out (if needed)

## Cross-cutting (every phase)

- [ ] X.1 Cross-tenant test added for every new route
- [ ] X.2 Index + `explain()` check for every new query
- [ ] X.3 DESIGN.md / RULE.md updated with any model, event or API change
- [ ] X.4 Monthly cost review against ARCHITECTURE §8
