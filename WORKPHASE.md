# WORKPHASE — what gets built, in which phase, and where it stands

> The owner's plain-language view of the build. **Kept current**: every time a task is finished, started, added or dropped, this file and [TASK.md](TASK.md) are updated in the same change (CLAUDE.md rule). `tests/workphase.test.ts` fails if a task's status here differs from TASK.md.
>
> Last updated: **2026-10-04**

**Legend:** ✅ Done · 🟡 In progress (partly built, note says what's left) · ⬜ To do · ❌ Dropped

Live app: https://am2pmsupportproject.vercel.app · Code: https://github.com/AM2PMSupport/AM2PM_Support_Project · Detailed task specs: [TASK.md](TASK.md) · Product: [PRD.md](PRD.md)

## Overview

| Phase | Focus | Done | In progress | To do | Complete |
| --- | --- | --- | --- | --- | --- |
| [Phase 0](#phase-0--decisions-and-setup) | Decisions and setup | 3 | 2 | 5 | 40% |
| [Phase 1](#phase-1--core-crm-weeks-16) | Core CRM (weeks 1–6) | 39 | 9 | 6 | 81% |
| [Phase 2](#phase-2--automation-weeks-710) | Automation (weeks 7–10) | 1 | 2 | 15 | 11% |
| [Phase 3](#phase-3--reporting-client-portal-backups-weeks-1114) | Reporting, client portal, backups (weeks 11–14) | 2 | 1 | 15 | 14% |
| [Phase 4](#phase-4--later-week-15) | Later (week 15+) | 0 | 0 | 8 | 0% |

## Next up (in order)

1. **Confirm inbound calls end-to-end** with one real incoming call on a mapped DID (T1.38a) — then Phase 1 telephony is fully done.
2. **Nightly per-client backups** (T1.43, T1.44) — needed before real client data grows.
3. **Manager digest email** at 09:00 (T1.42) — Resend key is already in Vercel.
4. **Spreadsheet migration script + pilot** (T1.45, T1.46) — needs 2–3 real crmv7 sheets from the owner (T0.8).
5. **Google Sheet 15-min pull** (T1.27) as the bridge during migration.
6. Teams screen (T1.13), Redis eligibility cache (T1.28), live-update stream (T1.40).

## Phase 0 — Decisions and setup

**Goal:** Before building: decide the open questions, create the cloud accounts and collect real samples from providers and clients.

**Features in this phase**
- Cloud stack on Vercel + Neon Postgres + Upstash (QStash, Redis) + Vercel Blob — **live**
- Read replica, health check, environment variables — **live**
- Still needed from the owner: final answers to open decisions, real client spreadsheets (anonymised), the list of client DIDs and agent phones, Vercel Pro upgrade

**Progress: 3 done · 2 in progress · 5 to do — about 40% complete**

| Task | Status | What | Notes |
| --- | --- | --- | --- |
| T0.1 | ⬜ To do | Close open decisions in [PRD.md §10](PRD.md#10-open-decisions) (volumes, live sources, `lead.converted` receivers, CallerDesk fallback, retention, build team) | — |
| T0.2 | 🟡 In progress | Create Vercel team + project (Pro plan); connect Git repo | — |
| T0.3 | ✅ Done | Provision Neon Postgres via Vercel Marketplace, region AWS Mumbai (ap-south-1); Free plan for dev/pilot; run `npm run db:migrate` | — |
| T0.4 | ✅ Done | Provision Upstash QStash + Redis via Vercel Marketplace | — |
| T0.5 | 🟡 In progress | Create Vercel Blob store (or R2 bucket) for recordings/CSVs; separate R2 account + bucket (versioning, object lock) for backups | Blob store `am2pm-crm-blob` (private, bom1) created 2026-10-01; R2 backup bucket still to do (T1.43) |
| T0.6 | ✅ Done | Pull env vars locally (`vercel env pull .env.local`); document all vars in README | — |
| T0.7 | ⬜ To do | Collect sample payloads: CallerDesk click-to-call responses (success + each error), outbound and inbound call webhooks (start, answer, call_report, missed, recording), Interakt, Brevo, Resend, Meta leadgen | — |
| T0.9 | ⬜ To do | Confirm with CallerDesk: click-to-call API params, webhook events and signing, custom/correlation field support, inbound routing options (sticky agent, routing-lookup URL), recording URL lifetime | — |
| T0.10 | ⬜ To do | List every client DID with its process and direction; list agent phone numbers | — |
| T0.8 | ⬜ To do | Export 2–3 real crmv7 spreadsheets (anonymised) as migration fixtures | — |

## Phase 1 — Core CRM (weeks 1–6)

**Goal:** Replace the Google Sheets CRM for day-to-day calling: leads come in, get de-duplicated and auto-assigned, agents call with one click (CallerDesk, no SIP), save outcomes and callbacks, managers watch the floor.

**Features in this phase**
- Sign-in, roles, one login per person with a Zoho-style workspace switcher
- Setup: processes & stages, outcomes, custom fields, team, lead sources, telephony, company settings, roles, audit log, API keys
- Leads: import (webhooks, web forms, CSV/Excel), dedupe, auto-assignment (equal / % / ratio / quota), Zoho-style list with filters, board, bulk actions, edit, recycle bin
- Console: queue, filters, prev/next, click-to-call, outcomes, callbacks with reminders, inline editing of every detail
- Calls: CallerDesk webhooks + 15-min sync, call log, recordings with player
- Floor dashboard on live data; notifications
- Left in Phase 1: Google Sheet pull, Redis eligibility cache, manager digest email, nightly per-client backups, spreadsheet migration script, pilot

**Progress: 39 done · 9 in progress · 6 to do — about 81% complete**

| Task | Status | What | Notes |
| --- | --- | --- | --- |
| T1.1 | 🟡 In progress | Scaffold Next.js (App Router, TS strict), Tailwind + shadcn/ui, ESLint, Prettier, Vitest, Playwright | — |
| T1.2 | ✅ Done | `lib/db/client.ts`: one `pg` pool (max 10) on Neon's pooled URL, Drizzle, `attachDatabasePool` | — |
| T1.3 | ✅ Done | `lib/db/tenant.ts`: `withTenant()` | transaction + `app.tenant_id` + `SET LOCAL ROLE app_rls`; row-level security in `drizzle/0001_rls.sql` |
| T1.4 | ✅ Done | Lint rule banning the raw pool / `pg` / platform db outside `lib/db` and `lib/platform-admin` | — |
| T1.5 | ✅ Done | Cross-tenant test harness (seed tenants A/B; helper to assert no leakage per route) | — |
| T1.6 | 🟡 In progress | Drizzle schema + SQL migrations (tables, FKs, indexes, RLS) + `npm run db:migrate` | — |
| T1.7 | ✅ Done | `lib/crypto`: AES-256-GCM encrypt/decrypt, HMAC sign/verify, SHA-256 helpers | — |
| T1.8 | ✅ Done | `lib/queue`: QStash publish helper + `/api/jobs/*` signature verification | — |
| T1.9 | 🟡 In progress | `/api/cron/*` with `CRON_SECRET`; `vercel.json` cron schedule | — |
| T1.10 | ✅ Done | Structured logging with PII redaction | — |
| T1.11 | ✅ Done | Sign-in: **email + password done** (scrypt hashes, signed HttpOnly session cookie, login throttle, protected screens, 8 seeded role accounts via `npm run seed:users`); Google / email OTP optional later | — |
| T1.12 | ✅ Done | Tenants CRUD (Super Admin); tenant settings (timezone, hours, retention) | workspaces (super admin), Company settings (name, timezone, currency), Zoho-style workspace switcher with one login per person (2026-10-02) |
| T1.13 | 🟡 In progress | Users + teams CRUD; roster fields (shareWeight, did, skills, maxOpenLeads, dailyQuota) | users CRUD, roster fields, password reset, cross-workspace login rules done; teams screen left |
| T1.14 | ✅ Done | RBAC: scope resolver (own/team/process/tenant/global) + permission matrix from DESIGN §7 | — |
| T1.15 | ✅ Done | Phone masking serializer by role | — |
| T1.16 | ✅ Done | `audit_logs` writer (insert-only DB user) | — |
| T1.17 | ✅ Done | Processes CRUD: stages, wonStage, dedupe rule, assignment config | — |
| T1.18 | ✅ Done | Dispositions CRUD with categories + actions; seed crmv7 defaults | — |
| T1.19 | ✅ Done | Custom field definitions + write-path validation + `custom` object | — |
| T1.20 | 🟡 In progress | Contacts + leads model; `phoneKey` normaliser (port `toTenDigits`, `isValidMobile10`, `phoneKey`) | — |
| T1.21 | ✅ Done | Dedupe insert with `ON CONFLICT DO NOTHING` → merge; `lead_events`; `is_active` + re-enquiry window | — |
| T1.22 | ✅ Done | Outbox writer (same transaction) + relay (post-commit publish + 1-min sweep) | — |
| T1.23 | ✅ Done | Import sources CRUD, field-map editor, source key shown once (stored hashed) | — |
| T1.24 | ✅ Done | Webhook API `/api/hooks/{tenant}/{sourceId}` → `webhook_events` → QStash | — |
| T1.25 | ✅ Done | Web-form source handler | — |
| T1.26 | ✅ Done | CSV/Excel upload → Blob → 500-row QStash batches → batch report + error file | Setup → Lead sources → Import: browser → private Blob `am2pm-crm-blob` → QStash `import-batch` per 500 rows → dedupe + inline assign; batch report + error CSV; file deleted after import |
| T1.27 | ⬜ To do | Google Sheet pull every 15 min with cursor (migration bridge) | — |
| T1.28 | 🟡 In progress | Eligibility filter + Redis cache (30 s) | — |
| T1.29 | ✅ Done | Equal, Percentage, Ratio (smooth weighted RR), Number (daily quota) | — |
| T1.30 | ✅ Done | Atomic pick transaction + retry ≤ 3; `lead.assigned` outbox | — |
| T1.31 | ✅ Done | Assignment sweeper cron (5 min) + SLA alert | SLA alert to supervisors/managers in the 5-min reminders job |
| T1.32 | ✅ Done | Nightly `open_leads` recount (`recount-open-leads` cron) | — |
| T1.33 | ✅ Done | My queue (callbacks due → fresh → recycled); availability toggle | — |
| T1.34 | ✅ Done | Lead workspace: contact card, custom fields, timeline, stage change | — |
| T1.35 | ✅ Done | Disposition + sub-disposition form; required before next call; callback quick picks | — |
| T1.36 | ✅ Done | Callbacks model + reminder cron (5 min): notify 15 min before, missed, escalate at 30 min | `lib/platform-admin/reminders.ts`, QStash schedule `am2pm-callback-reminders` every 5 min; bell in the top bar |
| T1.37 | ✅ Done | `TelephonyAdapter` interface + normalised call events (DESIGN §5.1) | — |
| T1.37a | ✅ Done | CallerDesk adapter `clickToCall` (10-digit numbers, `canonicalDid`, error mapping to plain messages) | verified against CallerDesk docs and live: click-to-call returns campid; real calls 2026-10-02/03 completed with webhooks + recordings |
| T1.37b | ✅ Done | Agent phone + DID on users; "Verify" test call; telephony admin screen (credentials, DIDs → process/direction, webhook URL) | — |
| T1.37c | ✅ Done | `POST /api/v1/leads/{id}/call`: access + DNC + `call:active` lock → `initiated` interaction → adapter → provider call id | — |
| T1.37d | 🟡 In progress | Outbound state machine from webhooks (initiated → … → completed); attempts; presence On call / Wrap-up; disposition required after end | — |
| T1.38 | ✅ Done | Telephony webhook route `/api/hooks/{tenant}/telephony/{provider}`; CallerDesk `verifyWebhook` + `parseWebhook`; port `resolveCustomerPhone_` + caller-leg cache (Redis) | route + verify (path secret) + parse per CallerDesk docs; 17 real webhooks processed 2026-10-02; legs explicit via Direction (no Redis leg cache needed) |
| T1.38a | 🟡 In progress | Inbound: DID → process, find/create contact + lead, interaction, screen-pop to answering agent (match `agentPhone`) | — |
| T1.38b | ✅ Done | Missed inbound: missed interaction, callback due now (owner or next eligible), one per number per day, `call.missed` | — |
| T1.38c | ✅ Done | Stuck-call sweeper (5 min): `initiated` > 10 min → `unknown`, release locks, alert on silent provider | — |
| T1.39 | ✅ Done | Recording copy to Blob/R2 + signed URL playback + audit | Calls screen (log, filters, totals, inline player), console timeline player, copy-recording → private Blob, /api/v1/calls/{id}/recording (scope-checked, audited), plus `sync-calls` every 15 min from CallerDesk call_list_v2 (2026-10-03) |
| T1.40 | 🟡 In progress | SSE `/api/v1/stream` (or 5 s poll of Redis counter) for new leads, inbound screen-pop and live call status | console polls every 2 s in a call / 20 s otherwise (incl. inbound screen-pop); SSE stream not built |
| T1.47 | ✅ Done | Quick search: trigram + call-lookup indexes and `searchContacts()` done (on Neon); `GET /api/v1/search` + search box in the agent UI after sign-in | `GET /api/v1/leads?q=` + Leads screen + top-bar search |
| T1.41 | ✅ Done | Conversion transaction (status won, converted_at, open_leads − 1, events) | — |
| T1.42 | ⬜ To do | Email sender (Resend) + manager digest cron 09:00 | — |
| T1.43 | ⬜ To do | Per-tenant backup worker: stream 5,000/batch, gzip, envelope AES-256-GCM, multipart to R2, cursor + re-queue, manifest | — |
| T1.44 | ⬜ To do | `backup_policies`, `backup_snapshots`; nightly cron 01:30; `backup.completed/failed` alerts | — |
| T1.45 | ⬜ To do | Migration script per spreadsheet: CRM_Calling, Marketing_Leads, CRM_WebhookLog, MissedCalls → tables; roster, dropdowns; Timeline History → `lead_events`; count reconciliation | — |
| T1.46 | ⬜ To do | Pilot: migrate one process; run in parallel with the sheet | — |

**Phase gate:** ⬜ pilot process lead counts match the sheet daily for 14 days

## Phase 2 — Automation (weeks 7–10)

**Goal:** Bring leads in automatically from ad platforms and directories, send events to client systems, and automate follow-ups over WhatsApp and email.

**Features in this phase**
- Connectors: Meta Lead Ads, Google Ads, IndiaMART, Justdial
- Public API — **done early** (REST + GraphQL + API keys)
- More assignment methods (load, skill/language/city, sticky owner), working-hours caps, stale-lead recycling
- Outbound webhooks to client CRMs with retries, failed-event replay
- Workflow engine (if this → then that)
- WhatsApp (Interakt), email campaigns (Brevo, Resend) with consent + DNC enforcement

**Progress: 1 done · 2 in progress · 15 to do — about 11% complete**

| Task | Status | What | Notes |
| --- | --- | --- | --- |
| T2.1 | ⬜ To do | Meta Lead Ads: leadgen webhook + Graph API fetch; page connect flow per client | — |
| T2.2 | ⬜ To do | Google Ads lead-form webhook | — |
| T2.3 | ⬜ To do | IndiaMART connector (push or 15-min pull with cursor) | — |
| T2.4 | ⬜ To do | Justdial connector (push or 15-min pull with cursor) | — |
| T2.5 | ✅ Done | Public API `POST /api/v1/leads` + tenant API keys | REST v1 (leads CRUD, outcome, stage, assign, calls, processes, users, me) + GraphQL `/api/graphql`, API keys (Setup → API keys), docs enforced by tests/api-docs.test.ts (2026-10-03) |
| T2.6 | ⬜ To do | Load-based, Skill/language/city, Sticky owner methods | — |
| T2.6a | ⬜ To do | Optional inbound routing lookup (`/telephony/{provider}/route`) returning the lead owner's number, if CallerDesk supports it | — |
| T2.7 | ⬜ To do | Working hours + caps enforcement in eligibility; tests across timezones | — |
| T2.8 | ⬜ To do | Stale-lead recycle cron (hourly); "agent leaves" bulk return to pool | — |
| T2.9 | ⬜ To do | Webhook subscriptions CRUD, secret shown once, test-send | — |
| T2.10 | 🟡 In progress | Delivery worker: HMAC signature, QStash retries, `webhook_deliveries`, auto-pause after 24 h | — |
| T2.11 | 🟡 In progress | Events: `lead.created`, `lead.assigned`, `disposition.set`, `lead.stage_changed`, `lead.converted`, `lead.lost`, `callback.missed`, `call.completed`, `call.missed` | events written to the outbox (lead.created/assigned, disposition.set, stage_changed, converted, lost, callback.missed, call.*); delivery needs T2.9 subscriptions screen |
| T2.12 | ⬜ To do | Failed events screen + Replay (DLQ) | — |
| T2.13 | ⬜ To do | Workflow engine: trigger → conditions → actions; `workflow_runs` | — |
| T2.14 | ⬜ To do | Interakt adapter: template sync, send, status webhook, consent gate | — |
| T2.15 | ⬜ To do | Brevo adapter: campaigns to consented contacts, status webhook | — |
| T2.16 | ⬜ To do | Resend adapter: broadcasts + transactional, unsubscribe link | — |
| T2.17 | ⬜ To do | `contacts.consent` UI + DNC enforcement across all senders | — |

**Phase gate:** ⬜ a signed `lead.converted` reaches a client system and is verified there

## Phase 3 — Reporting, client portal, backups (weeks 11–14)

**Goal:** Give managers and clients the reports they need, let clients log in to see their own data, and make backups / restore / security production-grade.

**Features in this phase**
- Daily rollups and dashboards (funnel, leaderboard, sources, callback compliance, time to convert…)
- Exports (done for leads), weekly agent report
- Client portal
- Audit log viewer — **done early**
- Backups page, two-person restore, weekly restore test
- 2FA + IP allow-list, retention / erasure (DPDP), rate limits
- Read replicas — **done early**; Neon Launch plan, DR drill, uptime monitor
- Move all remaining clients off Google Sheets

**Progress: 2 done · 1 in progress · 15 to do — about 14% complete**

| Task | Status | What | Notes |
| --- | --- | --- | --- |
| T3.1 | ⬜ To do | Daily rollup cron 00:30 (`$merge` into `daily_stats`) | — |
| T3.2 | ⬜ To do | Dashboards: funnel, leaderboard, source performance, callback compliance, time to convert, win/loss, week/month/quarter comparisons, day-of-week, stale leads, overdue callbacks | — |
| T3.3 | 🟡 In progress | CSV export (streamed; large → file + emailed link), masking by role, audit-logged | Leads → Export (current filter, ≤10k rows, masked per role, audited) done 2026-10-02; large export → emailed link left |
| T3.4 | ⬜ To do | Agent weekly report cron (Mon 08:00) | — |
| T3.5 | ⬜ To do | Client portal: processes, masked leads, assigned reports | — |
| T3.6 | ✅ Done | Audit log viewer | Setup → Audit log + Login history (2026-10-02) |
| T3.7 | ⬜ To do | Backups page: snapshots, backup now, download (fresh TOTP + 15-min URL), export CSV | — |
| T3.8 | ⬜ To do | Restore: request → approve (two-person) → sandbox / selective / full; webhooks muted; `restore.completed` | — |
| T3.9 | ⬜ To do | Weekly prune + verify (random-tenant restore test); monthly backup status email | — |
| T3.10 | ⬜ To do | TOTP 2FA + IP allowlist for agents | — |
| T3.11 | ⬜ To do | Retention cron 02:00: recordings to cold tier, erasure requests (DPDP) | — |
| T3.12 | ⬜ To do | Vercel Firewall rate limits on `/api/hooks/*` and login | — |
| T3.13 | ⬜ To do | Move Neon to the Launch plan (point-in-time restore) + IP allow list; add a read replica for reports if needed | — |
| T3.14 | ⬜ To do | Migrate remaining clients; set Apps Script sheets read-only | — |
| T3.15 | ⬜ To do | Upgrade Vercel team to Pro (commercial use) and restore the 1-min / 5-min cron schedules in `vercel.json` | — |
| T3.16 | ✅ Done | Create 1–2 Neon read replicas; set `DATABASE_REPLICA_URLS` in Vercel; move dashboard/report/export queries to `withTenantRead()` | replica-1 live, DATABASE_REPLICA_URLS set, Floor/Leads/Calls/reports read via withTenantRead (least connections + failover) |
| T3.17 | ⬜ To do | DR runbook + drill: restore latest backup into a Neon project in another region, repoint `DATABASE_URL`, measure RTO | — |
| T3.18 | ⬜ To do | Uptime monitor on `/api/health` (alert when `ok:false` or any replica out of rotation) | — |

**Phase gate:** ⬜ all clients off Sheets; Apps Script read-only

## Phase 4 — Later (week 15+)

**Goal:** Beyond the calling pipeline.

**Features in this phase**
- Training / LMS (per workspace)
- Attendance & shifts, reimbursements, billing
- More telephony providers (MyOperator, Exotel), auto-next calling, AI call QA

**Progress: 0 done · 0 in progress · 8 to do — about 0% complete**

| Task | Status | What | Notes |
| --- | --- | --- | --- |
| T4.1 | ⬜ To do | LMS / training-to-production gate | — |
| T4.2 | ⬜ To do | Attendance and shifts | — |
| T4.3 | ⬜ To do | Reimbursements | — |
| T4.4 | ⬜ To do | Billing plans, usage, invoices | — |
| T4.5 | ⬜ To do | MyOperator / Exotel click-to-call adapters + fallback integration | — |
| T4.6 | ⬜ To do | Auto-next: after a disposition, open the next queued lead and start click-to-call after a short, configurable countdown (still one API call per click-equivalent; no SIP, no predictive dialling) | — |
| T4.7 | ⬜ To do | AI call QA | — |
| T4.8 | ⬜ To do | Postgres LISTEN/NOTIFY or logical replication for near-instant fan-out (if needed) | — |

## Added during the build (not in the original plan)

Features the owner asked for while building. Each is live unless marked otherwise.

| Added | Feature | Phase it belongs to | Status |
| --- | --- | --- | --- |
| 2026-10-02 | Zoho-style workspaces: one login per person, switch organisation from the avatar; settings, leads, telephony and people all follow | 1 | ✅ Done |
| 2026-10-02 | Leads list like Zoho: saved filters, system filters, sort, board view, manage columns, records per page, wrap/clip, resizable columns, bulk assign / stage / delete | 1 | ✅ Done |
| 2026-10-02 | Lead edit (all details), Recycle bin with restore | 1 | ✅ Done |
| 2026-10-02 | Setup home as a searchable grid; Company settings, Roles & permissions, Login history, Remove sample data | 1 | ✅ Done |
| 2026-10-02 | Console: queue filter + prev/next, every detail editable in place, "End that call" for stuck calls | 1 | ✅ Done |
| 2026-10-02 | Speed work: fewer database round trips, loading skeletons (pages 0.2–0.4 s on production) | 1 | ✅ Done |
| 2026-10-03 | Calls page: call log, durations, talk time, recordings player; 15-min sync from CallerDesk | 1 | ✅ Done |
| 2026-10-03 | REST API v1 + GraphQL API + API keys; API.md enforced by tests | 2 (done early) | ✅ Done |
| 2026-10-03 | Developer tooling: graphify knowledge graph, ponytail plugin | — | ✅ Done |
| 2026-10-03 | Fixed-frame screens: Leads and Calls keep header, toolbar and paging fixed; filter rail and list scroll inside; columns keep their size on wide screens; filters slide over on small windows | 1 | ✅ Done |
| 2026-10-03 | Search/filters on every list: Team (name/email/phone, role, status, process), Audit log (action or person), Calls (recording, agent, result, name/phone), lead timeline (type chips + search) | 1 | ✅ Done |
| 2026-10-03 | Process filter on top of Leads and the console (all processes / one / any combination, "only" shortcut); console Filters panel (stage, source, owner, not called, callback due/later, missed call, has outcome) with Clear all; paging in Leads board view | 1 | ✅ Done |
| 2026-10-03 | One filter for Leads + console (+ REST/GraphQL): 15 system filters, campaign, last outcome, city, attempts range, created / last activity / next callback date ranges, and every custom field by type (text, dropdown, number range, date range, yes/no); console filters in a pop-up with Apply; applied filters shown as removable chips on both screens | 1 | ✅ Done |
| 2026-10-03 | Responsive console: 3 columns on wide screens, timeline inside the lead column on tablets, queue slide-over on narrow windows; compact top-bar clock | 1 | ✅ Done |
| 2026-10-03 | Login page: the brand clock is a working watch (hour, minute, second hands, live IST), corrected against the server clock via `GET /api/time` so a wrong PC clock doesn't show | 1 | ✅ Done |
| 2026-10-03 | Leads columns in your own order: drag (or ↑/↓) in Manage Columns, remembered per person; row Edit button kept | 1 | ✅ Done |
| 2026-10-03 | Mobile 2: a second number per contact — add/edit in Create, Edit and console Details; call icon per number on each Leads row; "Call Mobile 1 / Call Mobile 2" in the console (Shift+C); found by search; inbound call from Mobile 2 lands on the same lead; imports map a second phone column; REST/GraphQL `altPhone` | 1 | ✅ Done |
| 2026-10-03 | Fix: editing demo/imported leads stored without a dedupe key no longer fails with "another open lead has this number"; pasted double numbers are refused instead of half-saved | 1 | ✅ Done |
| 2026-10-04 | Fix: workspace menu and notifications no longer hidden behind page content on any module (pop-ups and drawers render above the page) | 1 | ✅ Done |
| 2026-10-04 | Fix: background jobs stopped mid-day (QStash daily quota used up) — one 5-minute schedule, inline auto-assign, lost CallerDesk webhooks recovered automatically; clearer "no caller-ID DID" message | 1 | ✅ Done |
| 2026-10-04 | Loading: AM2PM logo loader for full-page waits (first open, signing in, switching workspace); skeletons shaped like each screen (Floor, Console, Leads, Calls, Setup) and skeleton rows while Leads/Calls filters or pages load | 1 | ✅ Done |
| 2026-10-04 | Switching workspace keeps you on the module you were on (Leads, Calls, Floor, Setup tab…) when your role there can open it; otherwise your home screen. Filters and the open lead reset, since they belong to the old workspace | 1 | ✅ Done |
| 2026-10-04 | Workspace switcher moved to the top bar of every screen, right of the title: shows the current workspace (badge + name) and drops down the list of workspaces; the avatar menu keeps profile + Sign out | 1 | ✅ Done |

## How this file is kept up to date

- When a task **starts**: mark it 🟡 here and `[~]` in TASK.md, with a note saying what is left.
- When a task **finishes** (code + tests + docs + deployed): mark ✅ here and `[x]` in TASK.md, note the date.
- When the owner asks for a **new feature**: add it to the right phase (new task id in TASK.md, row here) and to "Added during the build".
- When something is **dropped**: mark ❌ with the reason; never delete the row.
- Update "Next up", the Overview numbers and "Last updated" in the same change.
- `tests/workphase.test.ts` checks that every task in TASK.md appears here with the same status.

## Update log

| Date | Change |
| --- | --- |
| 2026-10-04 | Owner request: workspace badge beside the screen title on every page, with the workspace list dropping down from it (not popping up from the bottom) |
| 2026-10-04 | Owner request: workspace switch stays on the current module instead of always opening Console |
| 2026-10-04 | Owner request: per-screen skeleton loaders for slow loads; AM2PM logo loader for full-page loading |
| 2026-10-04 | Owner report: bugs in every module — fixed menu layering (all modules) and the QStash quota outage behind stuck calls / unassigned leads / unprocessed webhooks |
| 2026-10-03 | Owner request: reorder Leads columns; Mobile 2 with click-to-call per number in Leads and console |
| 2026-10-03 | Owner request: live analog watch on the login page, synced to server time |
| 2026-10-03 | Owner request: more filters (system, every column, custom fields by type) in Leads and console; console filter pop-up + applied-filter chips |
| 2026-10-03 | Owner request: process filter (Leads + console), console filters like Leads, paging in board view |
| 2026-10-03 | Owner request: fixed-frame Leads/Calls, filters on all lists + lead timeline, responsive console (added under "Added during the build") |
| 2026-10-03 | WORKPHASE.md created. Statuses synced with TASK.md; corrected stale entries: T1.37a, T1.38 (verified with real CallerDesk calls), T3.6 audit log viewer and T3.16 read replicas done early, T3.3 export and T2.11 events partly done, T1.40 polling in place of SSE |
