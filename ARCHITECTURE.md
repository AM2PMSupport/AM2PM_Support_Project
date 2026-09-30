# ARCHITECTURE — AM2PM Call Center CRM

Version 1.1 · 1 October 2026. Data model and API details are in [DESIGN.md](DESIGN.md); hard rules in [RULE.md](RULE.md).

## 1. Shape in one sentence

Every external event is **saved and queued before any work runs**; short serverless functions do the work; **Neon Postgres is the only system of record**.

```
 Lead sources            Call & message providers        People
 (forms, Meta, Google,   (CallerDesk, Interakt,          (agents, managers,
  IndiaMART, Justdial,    Brevo, Resend)                  admins, client portal)
  CSV, Sheet, API)
        │                        │                              │
        ▼                        ▼                              ▼
 ┌──────────────────────── Vercel ─────────────────────────────────────────┐
 │  Webhook API /api/hooks/*                     Next.js app + API         │
 │  verify → insert webhook_events → publish      agent screen, admin,     │
 │  to QStash → 200 in < 100 ms                   portal, /api/v1, SSE     │──┐
 └──────────────┬─────────────────────────────────────────┬───────────────┘  │
                ▼                                         ▼                  │
 ┌──────────────────────── Upstash ───────────────────────────────────────┐  │
 │  QStash: retries, backoff, DLQ,               Redis: presence, live    │  │
 │  delayed msgs, cron fan-out                   counts, RR cursors,      │  │
 │                                               eligible-agent cache,    │  │
 │                                               rate limits              │  │
 └──────────────┬────────────────────────────────────────────────────────┘  │
                ▼                                                            │
 ┌──────────── Workers: Vercel Functions at /api/jobs/* (called by QStash) ─┐│
 │  Import+dedupe · Auto-assign · Calls/recordings · Outbox relay +         ││
 │  outbound webhooks · Workflows · Reminders · Rollups · Backups           ││
 └──────┬───────────────────────┬──────────────────────────┬───────────────┘│
        ▼                       ▼                          ▼                 │
  Client systems          Blob / R2                 Neon Postgres  ◄────────┘
  (ERP, ad platforms,     recordings, CSVs;         (Mumbai) system of record
   BI) signed webhooks    separate R2 for backups
```

## 2. Components

| Component | Technology | Responsibility | Must never |
| --- | --- | --- | --- |
| Web app + API | Next.js App Router on Vercel, Fluid compute | Agent screen, admin, client portal, `/api/v1`, SSE stream | Query without the tenant repository |
| Webhook API | Next.js route handlers `/api/hooks/*` | Verify, persist to `webhook_events`, publish to QStash, return 200 | Run business logic inline |
| Queue | Upstash QStash (Vercel Queues as alternative) | Deliver jobs with retry/backoff; DLQ; delayed messages (reminders) | Hold state beyond the message |
| Live state | Upstash Redis | Presence, live counts, eligible-agent cache (30 s), rate limits | Be the only copy of any record |
| Workers | Vercel Functions `/api/jobs/*` | Import, dedupe, assign, calls, webhooks, workflows, reminders, rollups, backups | Run longer than ~60 s — fan out or re-queue |
| Scheduler | Vercel Cron `/api/cron/*` → QStash fan-out | Replaces every Apps Script time trigger | Do heavy work in the cron request itself |
| Database | Neon serverless Postgres via Vercel Marketplace, AWS Mumbai (ap-south-1); Drizzle ORM; `pg` pool | System of record: relations with foreign keys, tenant isolation by row-level security | Store recordings or files |
| Files | Vercel Blob or Cloudflare R2 (private) | Recordings, CSV uploads, error reports | Serve public URLs |
| Backup store | Separate R2 account + bucket, versioning + object lock | Per-tenant encrypted snapshots | Be writable by the app's normal key |
| Auth | Auth.js: Google + email OTP, optional TOTP | Sessions, roles, 2FA | Store plain tokens |
| Telephony provider | CallerDesk (MyOperator / Exotel later), adapter layer | Phone lines, DIDs, IVR, inbound routing, bridging, recording; click-to-call API + call webhooks | Carry voice through our servers; be reached by SIP |
| Messaging providers | Interakt, Brevo, Resend (adapter layer) | WhatsApp, email | Be called outside an adapter |

### 2.1 Telephony model: API click-to-call, no SIP

```
 OUTBOUND                                         INBOUND
 Agent clicks Call in CRM                         Customer dials client DID
        │ POST /api/v1/leads/{id}/call                   │
        ▼                                                ▼
 CRM: access + DNC + no active call               Provider IVR + routing (provider panel)
        │ provider click-to-call API                     │ rings an agent's phone
        ▼                                                ▼
 Provider rings AGENT phone (leg A)               Agent answers on own phone
        │ agent answers                                  │
        ▼                                                ▼
 Provider dials CUSTOMER (leg B), bridges         Provider webhooks → /api/hooks/{tenant}/telephony/{provider}
        │                                                │
        └──────── call webhooks (ringing, answered, completed, recording, missed) ────────┐
                                                                                        ▼
                         CRM: interactions row · screen-pop via SSE · disposition required · recording copied
```

- **Voice never touches the CRM.** No SIP trunk, no PBX, no WebRTC, no browser audio. Agents use their own mobile or desk phone registered with the provider.
- **The CRM only does two things with the provider:** calls its click-to-call REST API (outbound) and receives its webhooks (both directions).
- **Inbound routing lives in the provider** (IVR, ring groups, sticky agent). Where the provider offers a routing-lookup webhook, the CRM can answer with the lead owner's number (phase 2, optional).
- **Call state** (initiated → agent ringing → answered → completed / missed / failed) is built only from webhooks. A Redis key `call:active:{userId}` blocks a second click while a call is live; it expires as a safety net.
- **Correlation:** the CRM creates the `interactions` row before calling the API and passes its id as the provider's custom field where supported; otherwise it matches on provider call id, agent number, customer number and time window.
- **Provider-agnostic:** each provider implements one adapter (`clickToCall`, `verifyWebhook`, `parseWebhook` → normalised call events). Adding MyOperator or Exotel means one new adapter, no other changes.

**Why no long-running processes:** Vercel functions are short-lived, so change streams, BullMQ workers and WebSocket servers from the original MongoDB design document are replaced by the **outbox pattern**, **QStash** and **Server-Sent Events**. Atlas Triggers can be added later if near-instant fan-out is needed.

**Codebase:** one Next.js repo as a modular monolith. Split a module out only when it needs independent scaling (likely telephony ingestion or analytics).

## 3. Key flows

### 3.1 Inbound webhook (any provider)
1. `POST /api/hooks/{tenant}/{source}` → verify signature / source key → 401 on failure.
2. `insertOne` into `webhook_events` with `idempotencyKey` (provider event id, else SHA-256 of body). Duplicate-key error → return 200, stop.
3. Publish event id to QStash → return 200.
4. QStash calls `/api/jobs/process-webhook` → handler by source.
5. Failure → 5 retries with backoff → DLQ → admin "Failed events" screen with Replay.

### 3.2 Lead import → dedupe → assign
```
arrive → normalise (fieldMap, E.164, phoneKey) → insertOne lead (unique dedupeKey)
   ├─ ON CONFLICT (partial unique index) → merge: lead_events + last_enquiry_at + alert owner
   └─ inserted → outbox lead.created → assign job
        → eligible agents (Redis cache 30 s) → pick by method (assignment_state)
        → transaction: lock lead + assignment_state (FOR UPDATE) ·
          UPDATE users SET open_leads+1 WHERE open_leads < max · set assigned_to ·
          lead_events · outbox lead.assigned
        → retry next agent ≤ 3 · none eligible → sweeper every 5 min · SLA alert
```

### 3.3 Outbound call (click-to-call)
| # | From → To | Action |
| --- | --- | --- |
| 1 | Agent UI → `POST /api/v1/leads/{id}/call` | agent clicks Call |
| 2 | API → Postgres / Redis | check lead access, contact not DNC, agent has an agent number and DID; set `call:active:{userId}` (NX, TTL 15 min) or reject "already on a call" |
| 3 | API → Postgres | insert `interactions` (call, outbound, status `initiated`, correlationId) |
| 4 | API → provider click-to-call API | agent number (leg A), customer number (leg B), caller-ID DID; returns provider call id → saved; errors shown to agent, lock released |
| 5 | Provider → agent phone → customer | provider rings agent; on answer dials customer and bridges |
| 6 | Provider → Webhook API → QStash → Worker | status webhooks update the interaction: agent_ringing, agent_no_answer, customer_ringing, answered, busy, no_answer, failed, completed |
| 7 | Worker → Postgres / Blob | call_report: duration, talk time, hangup by, recording URL → copy recording to Blob, store key; `leads.attempts + 1`, `lastInteractionAt` |
| 8 | Worker → Redis → Agent UI | release `call:active`, set agent to Wrap-up; SSE tells the screen the call ended |
| 9 | Agent UI → API → Postgres | disposition (+ callback) required; transaction with outbox `disposition.set`, `call.completed` |

### 3.4 Inbound call
| # | From → To | Action |
| --- | --- | --- |
| 1 | Customer → client DID → provider | IVR / routing in the provider rings an agent's phone |
| 2 | Provider → Webhook API | call start (caller, DID, answering agent number when known) |
| 3 | Webhook API → Postgres / QStash | insert `webhook_events`; publish; 200 |
| 4 | Worker → Postgres | DID → process (`telephony_dids` table); recover real caller (`resolveCustomerPhone_`); find/create contact by `phone_key` and lead by `dedupe_key` |
| 5 | Worker → Postgres | insert `interactions` (call, inbound, ringing / answered) |
| 6 | Worker → Redis → Agent UI | screen-pop via SSE to the agent whose number answered; if not yet known, to the lead owner and the process queue |
| 7 | Provider → Webhook → Worker | call_report: duration, recording → Blob; set `call:active` / Wrap-up for the answering agent |
| 8a | Answered | agent sets disposition + callback (transaction with outbox) |
| 8b | Missed / not answered | missed-call `interactions` row; callback due now for the owner (or next eligible agent); same number + same day merged; outbox `call.missed` |
| 9 | Outbox → QStash → Workflows | e.g. `disposition.set` → Interakt template; `call.missed` → "sorry we missed you" WhatsApp if consented |

Optional routing lookup (phase 2, provider permitting): provider asks `POST /api/hooks/{tenant}/telephony/{provider}/route` for an agent number; the CRM answers within the provider's timeout with the lead owner's number if available, else the provider's default routing.

### 3.5 Conversion
1. Agent saves a disposition with category `converted`, or moves stage to the process `wonStage`.
2. One transaction: `leads.status = won`, `convertedAt`, `users.openLeads − 1`, `lead_events` converted, `outbox` `lead.converted`.
3. Outbox relay publishes to QStash; each matching subscription gets a signed POST.
4. Workflows on `lead.converted` run (notify supervisor, thank-you WhatsApp, billing task).
5. Nightly rollup counts it in `daily_stats`.

### 3.6 Outbox relay
- The API publishes the outbox row to QStash right after commit and sets `publishedAt`.
- A 1-minute cron sweeps rows with `publishedAt: null`.
- Result: no event lost, none sent for a rolled-back change. Receivers dedupe on stable `id`.

## 4. Scheduled jobs (Vercel Cron → QStash)

| Job | Schedule (tenant TZ) | Replaces in crmv7 | What it does |
| --- | --- | --- | --- |
| Callback reminders | every 5 min | `processCallbackReminders` (hourly) | Notify 15 min before; mark missed; escalate after 30 min |
| Assignment sweeper | every 5 min | `runControlAutoAssign` | Assign leads left unassigned |
| Stuck-call sweeper | every 5 min | — | Mark `initiated` calls with no webhook after 10 min as `unknown`; release `call:active` locks; alert if a provider stops sending webhooks |
| Outbox relay | every 1 min | — | Publish unpublished events |
| Stale-lead recycle | hourly | `rptStaleLeads` | Reassign leads untouched for N hours |
| Scheduled imports | every 15 min | `syncMarketingToCalling` | Pull Sheet / IndiaMART / Justdial |
| Daily rollup | 00:30 | report builders | `INSERT … ON CONFLICT DO UPDATE` into `daily_stats` |
| Tenant backup | 01:30 | — | Encrypted per-client snapshot to R2 |
| Retention purge | 02:00 | — | `purge-expired`: delete expired webhook_events / outbox / deliveries (no TTL in Postgres) |
| Recording retention | 02:15 | — | Cold-store old recordings; run erasure requests |
| Backup prune + verify | Sun 03:00 | — | Expire snapshots; restore-test one random tenant |
| Manager digest | 09:00 | `runNotifications` | Hot leads, follow-ups due, disposition counts |
| Agent weekly report | Mon 08:00 | `sendAllUserReports` | Per-agent summary |
| Open-leads recount | 02:30 | — | `recount-open-leads`: fix `users.open_leads` drift |

## 5. Multi-tenancy

| Option | Verdict |
| --- | --- |
| Shared tables + `tenant_id` + row-level security | **Default** |
| Separate Neon project (or database) per tenant | Large or regulated clients only; needs a per-tenant connection resolver (not built yet) |
| Separate Postgres cluster per tenant | Avoid (cost) |

**Isolation is enforced by Postgres, not by remembering a filter.** Every tenant transaction (`withTenant()` in `lib/db/tenant.ts`) sets `app.tenant_id` and switches to the `app_rls` role (no BYPASSRLS). The row-level security policies in `drizzle/0001_rls.sql` hide other tenants' rows and reject writes for another tenant. `tenant_id` columns default to the setting, so inserts are stamped automatically. Only `lib/platform-admin` uses the owner connection, for cross-tenant sweeps. The integration tests prove this against real Postgres. See [RULE.md §1](RULE.md#1-tenant-isolation-non-negotiable).

## 6. Security and compliance

- TLS everywhere (Neon requires SSL); Neon encryption at rest; region AWS Mumbai (ap-south-1) for DPDP.
- Neon IP allow list limited to Vercel egress where the plan allows it.
- Roles: the owner role runs migrations and platform sweeps; `app_rls` (restricted, RLS-bound) runs all tenant work; `audit_logs` is insert-only for `app_rls`. A read-only `reporting` role is added with dashboards (T3.2).
- Provider secrets AES-256-GCM encrypted with a key in Vercel env vars; never returned by the API.
- Google sign-in + email OTP, optional TOTP 2FA and IP allowlist; 12-hour sessions stored hashed with an expiry.
- Phone masking by role; recordings via short-lived signed URLs; plays and exports audit-logged.
- Consent per channel; DNC blocks all outreach; erasure job; per-tenant retention; DPA per client.
- Vercel Firewall rate limits on `/api/hooks/*` (e.g. 300 req/min per source) and on login.

### Retention defaults (per tenant)
| Data | Hot | Archive | Delete |
| --- | --- | --- | --- |
| Interactions | 12 months in Postgres | Monthly partitions exported to R2 (Parquet), then detached | Per contract |
| Call recordings | 30 days standard | Infrequent-access tier | Per contract (30 days–2 years) |
| Audit logs | 1 year | Export to R2 | 5+ years |
| `webhook_events` | 60 days | — | `purge-expired` job (daily) |
| `workflow_runs`, `webhook_deliveries` | 90 days | — | `purge-expired` job (daily) |
| `outbox` | 30 days after publish | — | `purge-expired` job (daily) |

Postgres has no TTL indexes, so a daily `purge-expired` cron deletes expired rows (`lib/platform-admin/sweeps.ts`).

## 7. Backup and restore

Two layers, because a platform point-in-time restore rewinds the whole database and would roll back every client at once.

| Layer | Protects | How | Target |
| --- | --- | --- | --- |
| 1 · Platform | Outage, corruption, bad migration | Neon point-in-time restore (history window up to 7 days on Launch; longer on Scale) and instant branches; weekly `pg_dump` to R2 in a second region | RPO minutes, RTO ~1 h |
| 2 · Per client | Bad import, bulk delete, wrong reassignment, contract exit | Nightly logical export of every tenant table filtered by `tenant_id` | RPO 24 h (6 h premium), RTO < 1 h |

**How a per-client backup runs on serverless**
1. Cron 01:30 publishes one QStash message per tenant × table (or Backup now, max once a day).
2. Worker reads rows in keyset-paginated batches of 5,000 (`where tenant_id = … and id > last`) with a multipart upload to R2; near the time limit it saves the last id in `backup_snapshots.cursor` and re-queues itself.
3. Each file: JSON Lines (types preserved: UUIDs, timestamptz, JSONB) → gzip → AES-256-GCM with a per-tenant data key; data key encrypted by a master key (envelope). Deleting a tenant key = crypto-erasure.
4. Path: `backups/{tenantSlug}/{YYYY-MM-DD}/{table}.jsonl.gz.enc` + `manifest.json` (counts, bytes, SHA-256).
5. Done → `backup_snapshots.status = completed`, emit `backup.completed`; 3 failures → `backup.failed` + ops alert.
6. Weekly full + daily incrementals (`updated_at` after last snapshot + a deleted-ids list).

**Contents:** all tenant tables, with password/2FA/source/webhook secrets removed. **Excluded:** `webhook_events`, `outbox`, sessions, integration credentials. Recordings are not copied; a manifest lists them and the recordings bucket is versioned with 30-day delete protection.

**Restore modes:** sandbox (restore into a Neon branch or a read-only copy tenant, deleted after 7 days), selective (`INSERT … ON CONFLICT DO UPDATE` for chosen tables/ids, newer data kept unless overwrite), full rollback (pre-restore snapshot, tenant read-only, replace, recount, reopen). Two-person rule; webhooks and workflows muted; single `restore.completed` at end; every row's `tenant_id` re-checked.

**Retention:** Standard 7 daily · 4 weekly · 3 monthly. Premium 14 · 8 · 12 + 6-hourly incrementals + second region. Contract exit: final full backup to client, deletion certificate after 30 days.

**Verification:** SHA-256 check before download/restore; weekly random-tenant restore test; monthly status email to client admins; quarterly platform restore drill.

## 8. Cost (USD/month, approximate, prices checked 30 Sep 2026)

| Item | Pilot: 1 client, ≤20 agents | Growth: ~200 agents | Scale: ~2,000 agents |
| --- | --- | --- | --- |
| Vercel Pro (Hobby is non-commercial) | $20 | ~$30 | ~$60–100 |
| Neon Postgres ($0.106/CU-hour, $0.35/GB-month) | $0 (Free: 100 CU-h, 0.5 GB) | ~$22 (~150 CU-h + 10 GB + restore) | ~$210 (~1,460 CU-h + 100 GB + restore) |
| Upstash QStash ($1 / 100K msgs) | $0 (1,000/day free) | ~$10 | ~$30 |
| Upstash Redis | $0 | ~$5 | ~$20 |
| Recording storage | ~$0 | ~$3 | ~$30 |
| Per-client backups (R2) | ~$0 | ~$1–5 | ~$20 |
| **Total** | **~$20** | **~$70–75** | **~$370–410** |

Provider charges (CallerDesk minutes, WhatsApp template fees, email volume) excluded. The MongoDB Atlas option costed ~$28 / ~$105 / ~$550 (MEMORIE.md decision log, 2026-10-01).

**Cost rules:** recordings never in the database (only the storage key); `purge-expired` deletes raw payloads daily; dashboards read `daily_stats` only; keep Neon scale-to-zero on for dev/preview branches; move from Free to Launch before the first paying client (Free has no point-in-time restore).

## 9. Scaling path

1. Neon Free (pilot) → Launch before the first paying client → raise the autoscaling ceiling as agents grow (up to 16 CU on Launch).
2. Add a Neon read replica for dashboards and client reports when reporting load competes with agents.
3. Partition `interactions` and `lead_events` by month once they pass ~50M rows; export and detach old partitions per retention.
4. Move a noisy or regulated client to its own Neon project (requires the per-tenant connection resolver).
5. Add Ably/Pusher only if SSE/polling costs too much at 2,000 concurrent agents.
