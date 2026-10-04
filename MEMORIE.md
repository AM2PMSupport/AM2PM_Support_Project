# MEMORIE — Project memory

Durable context for anyone (human or AI) working on this project: what was decided, why, what is still open, and the facts that are easy to forget. Add new entries at the top of each section with a date.

## 1. Project facts

- **Company:** AM2PM Support Pvt. Ltd. — a BPO running calling processes for many client businesses.
- **Owner / product lead:** Ankit Kapoor (ankit@am2pmsupport.com).
- **What we are building:** one multi-client call-center CRM to replace per-client Google Sheets.
- **Scale targets:** pilot ≤20 agents → ~200 agents → ~2,000 agents.
- **Region:** India; data in Neon Postgres, AWS Mumbai (ap-south-1), for the DPDP Act.
- **Time:** tenants mostly `Asia/Kolkata`; store UTC, display tenant timezone.
- **Current system:** `crmv7.gs` = "Sheet CRM v4.9", Google Apps Script, ~11,300 lines, ~409 functions. The file is no longer in this folder (moved when `Docs/` was created); ask the owner if code needs to be ported line by line.

## 2. Source documents

| Doc | Location | Notes |
| --- | --- | --- |
| Architecture & DB design v1.1 (1 Oct 2026) | `Docs/AM2PM_CRM_Architecture_and_DB_Design.docx` | **Source of truth** for product scope, flows and backup design. Its database choice (MongoDB Atlas) was superseded on 2026-10-01 by Neon Postgres |
| Architecture deck v1.0 (1 Oct 2026) | `Docs/AM2PM_CRM_Architecture_Deck.pptx` | 21 slides; same decisions |
| Low-cost system design (30 Sep 2026) | Claude Doc: https://claude.ai/code/artifact/29ccc5aa-6e7b-45bb-8289-0f2c644f9da7 | Earlier Neon Postgres variant; superseded on DB choice |
| Original "Call Center CRM: Architecture & MongoDB Design" v1 | removed from folder | NestJS + BullMQ + K8s + sharding; structure kept, runtime dropped |
| `crmv7.gs` | removed from folder | Business logic source |

## 3. Decision log

| Date | Decision | Why | Alternatives rejected |
| --- | --- | --- | --- |
| 2026-10-03 | **Public API = REST v1 + GraphQL** (owner request), both thin layers over the same lib/* functions the screens use; auth = session cookie or per-workspace API key (read/write scope, acts as its creator, 600 req/min); GraphQL via graphql-yoga at `/api/graphql` (depth limit, no batching, total/outcomes computed only when selected). API.md is enforced by `tests/api-docs.test.ts` (every route+method documented; §6.2 SDL == code) | One behaviour, two shapes: REST for simple integrations/webhooks/files, GraphQL for apps that need several things in one round trip; enforcing docs in CI is the only way "always update API.md" holds | GraphQL-only (bad for webhooks/CSV/audio, harder for simple partners); OAuth for partners (not needed yet — keys are revocable and scoped) |
| 2026-10-02 | **CallerDesk integration verified against its API docs** (api.callerdesk.io Postman collection): click-to-call sends mandatory `call_from_did=1`; outgoing calls are matched by `campid` (click-to-call response ↔ call report); webhook fields `Direction` (IVR/WEBOBD), `SourceNumber`/`DialWhomNumber` legs by direction, `LegA/LegB_Picked_time` for the outgoing result, IST timestamps, `CallRecordingUrl`. Provider-facing webhook URLs use `PUBLIC_URL` (never localhost). Agents can "End that call" when no webhook arrives | crmv7-era field names were guesses; the owner's CallerDesk webhook pointed at localhost, so no event could arrive | Polling CallerDesk's Live call / Call report APIs instead of webhooks (extra load, delays; kept as a possible fallback) |
| 2026-10-02 | **Zoho-style workspaces** (owner request): one **login per person** (`accounts`, global, app role has no access) + a **membership per workspace** (`users`, role per workspace); avatar → profile panel switches workspace and everything (setup, leads, telephony, people) follows via RLS. Client admins can't link existing logins or reset multi-workspace logins — super admins only; super admins can enter any workspace (audited). Also: Leads screen like Zoho (saved filters, system filters, sort, list/board, columns, page size, bulk assign/stage, Create Lead, export) and Setup as a searchable category grid with Company settings, Roles & permissions, Audit/Login history, Remove sample data | Per-workspace passwords with "same email = same person" would let an admin of client A take over an AM2PM staff login and reach client B; a global identity with super-admin-only cross-linking is the Zoho model at no extra cost (2 tables, no new service) | Email-only matching across workspaces (unsafe); separate deployments per client (cost, ops); third-party identity provider (paid, not needed yet) |
| 2026-10-02 | **Round-trip budget for page speed** (owner: "too slow"): (1) `withTenant` sets tenant + role in ONE statement (`set_config('role','app_rls',true)` = `SET LOCAL ROLE`); (2) a screen's data is one statement where possible (lead panel and queue use `json_agg` / scalar subqueries) or independent reads run in parallel as separate short transactions (Floor, Leads, Setup); (3) console first paint = queue + lead in one transaction; (4) outcome/stage saves publish the outbox with `after()` and return the refreshed lead; (5) `app/(app)/loading.tsx` skeleton. Result: prod pages 0.22–0.40 s, save 0.2 s; local dev 0.5–0.7 s (was 1.3–2.1 s) | Latency is round trips × distance (laptop→Neon Singapore ≈ 100 ms; sin1→Neon ≈ 2 ms), not slow queries | Caching tenant data in Redis (staleness, invalidation); moving Neon/functions (already co-located in Singapore) |
| 2026-10-01 | **Email + password sign-in** (owner request) with one seeded account per role (8, workspaces `am2pm` + `demo-client`); scrypt hashes in DB, plain passwords only in git-ignored `PASSWORD.md`; signed HttpOnly cookie sessions; login throttle via Redis | Owner needs working role logins now; no Google OAuth keys yet | Auth.js Google/OTP first (blocked on keys) |
| 2026-10-01 | **Automation over instructions:** Claude performs infra/setup tasks itself via Vercel CLI and provider CLIs; owner is asked only for OAuth/billing approvals or secrets | Owner's standing instruction | Handing manual dashboard steps to the owner |
| 2026-10-01 | **Indexing for quick call lookup and search:** btree indexes for every call/queue query; `pg_trgm` + `btree_gin` GIN indexes for partial name / phone-digit / email search, tenant-first | Screen-pop and search stay in milliseconds as clients grow; no separate search service needed | Elasticsearch / Atlas Search (extra service and cost); unindexed ILIKE (slow at scale) |
| 2026-10-01 | Read replica `replica-1` created on Neon project `jolly-flower-95357933` (`am2pm-crm-db`), read-only, 0.25–2 CU, via `neonctl`; pooled URL in `DATABASE_REPLICA_URLS` (Vercel production + development, `.env.local`) | Least-connections read routing is live; `/api/health` reports it | — |
| 2026-10-01 | **High availability:** rely on Neon's multi-AZ storage replication and automatic compute recovery; add read replicas with **least-connections** routing and primary fallback in our code (`withTenantRead`); cross-region DR by backup restore (Neon has no cross-region replication) | Managed replication covers AZ failures at no extra cost; least-connections spreads read load; the circuit breaker keeps reads up if a replica fails | Self-managed Postgres with streaming replication + PgBouncer/HAProxy (ops burden); multi-region active-active (not supported by Neon; cost) |
| 2026-10-01 | Deploy on Vercel **Hobby** for now with the 3 frequent crons set to daily (project `am2pm_support_project`, team `am2pm-projects`). Neon Free in Singapore (`sin1`, no Mumbai region on the Vercel integration); QStash Free in Frankfurt; Redis = dedicated `am2pm-crm-redis` (Mumbai `bom1`, pay-as-you-go, eviction off; created via the Vercel API) — not shared with any other project; functions pinned to `sin1` | Get a live deployment without paying yet; leads and webhooks still process immediately, only safety-net sweeps are daily | Upgrade to Pro now ($20/month) — to do before commercial use (T3.15). Give the CRM its own Redis in Mumbai (`bom1`) when upgrading |
| 2026-10-01 | **Telephony = API click-to-call only, no SIP.** Calls both inbound and outbound through the cloud provider (CallerDesk first); agents talk on their own registered phones | Matches how AM2PM works today (crmv7 click-to-call); no SIP/PBX/WebRTC to run or secure; cost stays per-minute with the provider | SIP trunk + PBX (Asterisk/FreeSWITCH), WebRTC browser softphone, predictive dialer |
| 2026-10-01 | **Neon Postgres only** (replaces MongoDB Atlas). Drizzle ORM, `pg` pool, row-level security per tenant, foreign keys, JSONB for custom fields | Relational CRM data; isolation enforced by the database, not by app code; ~$70–75 vs ~$105/month at 200 agents; SQL reporting | MongoDB only; MongoDB + Neon hybrid (two systems of record, sync, higher cost) |
| 2026-10-01 | ~~MongoDB Atlas as the database~~ (superseded same day) | Flexible per-client custom fields, one document per lead, reuses the MongoDB schema work | Neon Postgres: ~1.5× cheaper and has RLS; still listed as an open decision |
| 2026-10-04 | **One QStash schedule (`tick`, 5 min)** runs reminders + all 15-min sweeps; unassigned leads are assigned inline, never one message per lead; webhooks stuck in `received` are re-queued | On 2026-10-03 five schedules (672/day) + per-lead `assign-lead` messages hit the free plan's 1,000 messages/day by 08:15 UTC: every job and CallerDesk webhook stopped until midnight UTC, and webhooks whose publish failed were then lost as "duplicates" | QStash pay-as-you-go (paid; still worth it at scale), Vercel Pro crons |
| 2026-10-03 | Second number = first-class `contacts.alt_phone_*` ("Mobile 2"), not a custom field | Must be callable, searchable and matched on inbound calls with an index; dedupe stays on the main number | Phone-type custom field (no index, not matched on inbound) |
| 2026-10-01 | Per-client logical backups to a separate R2 bucket, plus Neon point-in-time restore | A platform restore rewinds every client at once | Platform-only backups |
| 2026-10-01 | Two-person rule for restores; fresh TOTP for downloads | Restores and downloads are the highest-risk actions | Single approver |
| 2026-09-30 | Serverless: Next.js on Vercel + Upstash QStash + Redis + Vercel Cron | No servers or ops staff; cost follows usage | NestJS + BullMQ on Kubernetes (~$400+/month + ops) |
| 2026-09-30 | Outbox pattern for events (no change streams) | Vercel functions cannot hold long-running listeners; guarantees no lost/phantom events | MongoDB change streams, Postgres LISTEN/NOTIFY listeners, Atlas Triggers (later option) |
| 2026-09-30 | SSE or 5 s poll for live updates | No WebSocket servers on Vercel | Socket.IO + Redis adapter; Ably/Pusher only if needed at 2,000 agents |
| 2026-09-30 | Smooth weighted round-robin for Percentage/Ratio | crmv7 gives contiguous blocks, so one agent gets the freshest leads | crmv7 `buildAssignmentSequence` |
| 2026-09-30 | Dedupe = process + last 10 digits of phone, enforced by unique partial index on `isActive` | Keeps crmv7 behaviour; race-safe | Find-then-insert |
| 2026-09-30 | Shared DB + `tenantId`; dedicated DB for large/regulated clients | Cheapest, simplest ops | Cluster per tenant |
| 2026-09-30 | Modular monolith in one Next.js repo | Small team, one deploy | Microservices |
| 2026-09-30 | Phase 4 deferrals: LMS, attendance, shifts, reimbursements, invoicing | Focus v1 on the calling pipeline | — |

## 4. Open questions (from PRD §10)

- [x] Final DB: Neon Postgres (2026-10-01)
- [ ] Agents and leads per day at launch and in 12 months
- [ ] Lead sources live today
- [ ] Receivers of `lead.converted`; definition of "converted" per client
- [ ] CallerDesk only, or MyOperator / Exotel click-to-call as fallback in v1
- [ ] Inbound routing only in the provider panel, or CRM routing lookup (sticky agent) if CallerDesk supports it
- [ ] Agent phones: personal mobiles or office desk phones; who pays for agent-leg minutes
- [ ] Recording retention per client contract
- [ ] Backup retention; client self-download of full backups
- [ ] In-house or contractor build

## 5. Key numbers

| Item | Value |
| --- | --- |
| Monthly cost (pilot / growth / scale) | ~$20 / ~$70–75 / ~$370–410 (Neon) |
| Neon | Free: 100 CU-h, 0.5 GB, no PITR · Launch: $0.106/CU-hour, $0.35/GB-month, PITR up to 7 days |
| QStash | 1,000 msgs/day free; $1 per 100K; each retry is a message |
| Vercel | Pro $20; Hobby is non-commercial |
| Webhook ACK target | < 100 ms |
| Call click → provider accepted | < 2 s p95 |
| Inbound screen-pop | < 3 s after answer webhook |
| Stuck call timeout | 10 min without webhook → `unknown` |
| Assignment target | < 10 s p95 |
| Reminder timing | 15 min before; escalate 30 min after due |
| Outbound retries | ~1m, 5m, 30m, 2h, 12h; auto-pause after 24 h |
| Signature freshness | 300 s |
| Import pull interval | 15 min; CSV 500 rows per QStash message |
| Backup batch | 5,000 docs; standard 7/4/3, premium 14/8/12 + 6-hourly |
| RPO / RTO per client | 24 h (6 h premium) / < 1 h |
| Retention (purge-expired job) | webhook_events 60 d; workflow_runs, webhook_deliveries 90 d; outbox 30 d |
| Custom fields | max ~50 per entity |

## 6. crmv7 behaviours to preserve

- `phoneKey` = last 10 digits; valid mobile `^[6-9]\d{9}$`.
- Callback dispositions detected by `/call.?back/i` or `/follow.?up/i`, not exact labels; default callback time 11:45 AM if blank.
- Config numbers allow a real `0` (crmv7 `cfgIntDefault`).
- Click-to-call via CallerDesk `click_to_call_v2`: rings the agent's phone (`calling_party_a` = roster Agent Phone) then the customer (`calling_party_b`), caller ID = DID (per-user DID, else Default DID).
- CallerDesk DID must keep its leading 0 (`canonicalDid`); click-to-call numbers sent without country code.
- Inbound IVR calls were filtered into `CRM_Inbound`; missed calls into `MissedCalls`, one per number per day (`missedCallDateKey_`).
- CallerDesk caller-leg switching: the real caller is recovered from the cached "Transferring" leg (`resolveCustomerPhone_`, `cacheCallerLeg_`).
- Opt-in required by default for Interakt / Brevo / Resend sends (missing setting = ON).
- Email notifications default ON; timeline history default OFF in crmv7 (always ON as `lead_events` now).
- Bulk send caps per run: Interakt 200, Brevo 500, Resend 300 (hard ceiling 1,000) — keep as per-tenant rate limits.

## 7. Glossary

| Term | Meaning |
| --- | --- |
| Tenant | A client organisation (and AM2PM itself) |
| Process | A campaign / line of business for one client |
| Disposition | Outcome of a call; its category drives automation |
| Stage | Pipeline position (e.g. Hot, Warm, Cold, Won) |
| DID | Virtual number: caller ID for outbound calls, dial-in number for inbound |
| Click-to-call | Provider API call that rings the agent's phone, then the customer, and bridges them |
| Leg A / Leg B | Agent leg / customer leg of a click-to-call |
| Screen-pop | CRM opens the caller's lead on the agent's screen when a call connects |
| SIP | Internet telephony protocol — deliberately **not** used in this system |
| Outbox | Events written in the same transaction as the change |
| DLQ | QStash dead-letter queue |
| PITR | Point-in-time restore (Neon Launch and above) |
| RLS | Postgres row-level security: `app_rls` role + `tenant_isolation` policies |
| DPDP | India's Digital Personal Data Protection Act |
| RR | Round-robin |
