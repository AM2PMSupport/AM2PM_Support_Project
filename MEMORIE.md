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
| 2026-10-01 | **Telephony = API click-to-call only, no SIP.** Calls both inbound and outbound through the cloud provider (CallerDesk first); agents talk on their own registered phones | Matches how AM2PM works today (crmv7 click-to-call); no SIP/PBX/WebRTC to run or secure; cost stays per-minute with the provider | SIP trunk + PBX (Asterisk/FreeSWITCH), WebRTC browser softphone, predictive dialer |
| 2026-10-01 | **Neon Postgres only** (replaces MongoDB Atlas). Drizzle ORM, `pg` pool, row-level security per tenant, foreign keys, JSONB for custom fields | Relational CRM data; isolation enforced by the database, not by app code; ~$70–75 vs ~$105/month at 200 agents; SQL reporting | MongoDB only; MongoDB + Neon hybrid (two systems of record, sync, higher cost) |
| 2026-10-01 | ~~MongoDB Atlas as the database~~ (superseded same day) | Flexible per-client custom fields, one document per lead, reuses the MongoDB schema work | Neon Postgres: ~1.5× cheaper and has RLS; still listed as an open decision |
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
