# PRD — AM2PM Call Center CRM

| | |
| --- | --- |
| Owner | Ankit Kapoor, AM2PM Support Pvt. Ltd. |
| Version | 1.1 · 1 October 2026 |
| Status | Approved for build; open decisions in §10 |
| Source docs | `Docs/AM2PM_CRM_Architecture_and_DB_Design.docx` (v1.1), `Docs/AM2PM_CRM_Architecture_Deck.pptx` |
| Related | [ARCHITECTURE.md](ARCHITECTURE.md) · [DESIGN.md](DESIGN.md) · [RULE.md](RULE.md) · [TASK.md](TASK.md) |

## 1. Summary

AM2PM runs outbound and inbound calling for many client businesses. Today each client runs on a Google Sheet driven by an Apps Script CRM (`crmv7.gs`, Sheet CRM v4.9, ~11,300 lines). It works, but it breaks at scale and needs people to click "Sync" and "Auto-Assign".

We will build one multi-client web CRM on **Vercel (Next.js) + Neon serverless Postgres + Upstash (QStash, Redis) + Vercel Blob / Cloudflare R2**. It should cost about **$20/month in pilot, ~$70–75/month at 200 agents and ~$370–410/month at 2,000 agents**, with no servers or ops staff.

Three things must run by themselves from day one:

1. **Auto-import**: every lead source pushes a webhook or is pulled every 15 minutes.
2. **Auto-assignment**: each lead is deduped and given to an eligible agent within seconds, atomically.
3. **Outbound webhooks**: `lead.converted` and other events are HMAC-signed, retried for 24 hours and logged.

**Telephony is API click-to-call only — no SIP.** The cloud telephony provider (CallerDesk first) owns the phone lines, IVR, routing and recordings. For an **outbound** call the CRM asks the provider to ring the agent's own phone, then the customer, and bridge them. For an **inbound** call the customer dials the client's number and the provider routes it to an agent's phone. In both cases the provider sends webhooks and the CRM logs the call, shows the lead on screen and requires a disposition. Agents talk on their mobile or desk phone, never in the browser.

## 2. Problem

| Today (crmv7 on Sheets) | Impact |
| --- | --- |
| Leads move from `Marketing_Leads` to `CRM_Calling` only when someone runs Sync | Leads wait; speed-to-lead suffers |
| Auto-assign is a menu action; hands out leads in contiguous blocks | First agent gets all the freshest leads |
| Apps Script: 6-minute runs, 25 s lock on `doPost`, ~10M cells per sheet | Webhooks throttled during call spikes; sheets fill up |
| One spreadsheet per client, secrets in plain Config cells | No central view; weak isolation and security |
| No outbound events | Clients cannot sync conversions to their ERP or ad platforms |
| No per-client backup | A bad import or bulk edit is hard to undo |

The earlier MongoDB design (NestJS + BullMQ + Kubernetes + sharding) fixes structure but costs ~$400+/month plus ops staff before it has one agent. A serverless MongoDB Atlas variant was also costed (~$105/month at 200 agents); Neon Postgres was chosen on 2026-10-01 for relational integrity, database-enforced tenant isolation and lower cost.

## 3. Goals and non-goals

**Goals**
- G1: Replace Sheets for every client within 14 weeks of build start.
- G2: New lead to assigned agent in under 10 seconds (p95) during working hours.
- G3: Zero duplicate leads from racing imports (enforced by a unique index).
- G4: Every `lead.converted` delivered to subscribed client systems, signed, with retry.
- G5: Monthly infra cost within the stage budgets in §1.
- G6: Any single client restorable on its own, RPO 24 h, RTO under 1 h.

**Non-goals for v1** (schema reserved, phase 4): LMS / training gate, attendance and shifts, reimbursements, invoicing, AI call QA.

**Out of scope entirely (telephony):** SIP trunks, a SIP/PBX server (Asterisk, FreeSWITCH), WebRTC or browser softphones, in-browser audio, predictive or parallel auto-dialling. The CRM does not carry voice, and it does not transfer, hold, mute, conference or barge calls itself; the agent's phone and the provider handle those.

## 4. Users and roles

| Role | Who | Main jobs |
| --- | --- | --- |
| Super Admin | AM2PM platform owner | Tenants, cross-client view, approve restores |
| Admin | AM2PM or client admin | Users, processes, sources, dispositions, webhooks, backups |
| Project Supervisor | AM2PM | Process health, reassignments, SLA alerts |
| Manager | AM2PM | Team performance, reports, approvals |
| Process Coordinator | AM2PM | Day-to-day process config and lead handling |
| Trainer | AM2PM | Reserved for LMS (phase 4) |
| Client | Client business user | Read-only portal: own processes, masked phones, assigned reports |
| Agent | AM2PM caller | Work the queue, call, set dispositions, schedule callbacks |

Data scopes: `own`, `team`, `process`, `tenant`, `global`. Full matrix in [DESIGN.md §7](DESIGN.md#7-access-control).

## 5. Functional requirements

### 5.1 Tenancy and setup
- FR-1: Super Admin creates tenants (client organisations) with timezone, currency, working hours and retention settings.
- FR-2: Admin creates processes (campaigns) per client with stages, won stage, dispositions, assignment method, dedupe rule.
- FR-3: Admin manages users, roles, process mapping, teams, DID, share weight, skills, max open leads.
- FR-4: Per-tenant and per-process custom fields (text, number, dropdown, multiselect, date, boolean, phone, email), max ~50 per entity.

### 5.2 Lead auto-import
- FR-5: Sources: website forms, Meta Lead Ads, Google Ads lead forms, IndiaMART, Justdial, CSV/Excel, Google Sheet, public API.
- FR-6: Push sources hit `POST /api/hooks/{tenant}/{sourceId}`; pull sources run every 15 minutes with a saved cursor.
- FR-7: Per-source field map set in the admin UI; unmapped fields go to `custom`.
- FR-8: CSV imports return a per-row report (inserted, duplicate, failed) and a downloadable error file.
- FR-9: Rows with no valid phone and no email are rejected and logged.

### 5.3 Dedupe
- FR-10: Default key = process + last 10 digits of phone (crmv7 `phoneKey`); per process, switchable to email or any field.
- FR-11: A duplicate merges: source appended to history, `lastEnquiryAt` bumped, owner alerted.
- FR-12: Re-enquiry window: after N days a closed lead is archived and a repeat creates a new lead.

### 5.4 Auto-assignment
- FR-13: Methods: Equal, Percentage, Ratio, Number (daily quota), Load-based, Skill/language/city, Sticky owner.
- FR-14: Percentage/Ratio interleave (smooth weighted round-robin), not contiguous blocks.
- FR-15: Eligibility: active → mapped to process → available → in working hours → under `maxOpenLeads` → under quota → skills match.
- FR-16: No eligible agent: lead waits; 5-minute sweeper retries; supervisor alerted after the process SLA.
- FR-17: Untouched leads recycle after N hours (per process); leaving agent's leads return to pool in one action.

### 5.5 Agent workspace
- FR-18: Queue order: callbacks due now → fresh leads → recycled leads; new leads appear live (SSE or 5 s poll).
- FR-19: **Call** button = API click-to-call (see §5.6). One click places one call; the agent's registered phone rings first.
- FR-20: Disposition required before the next call; category drives callback, convert, DNC or close.
- FR-21: Callback scheduling with quick picks; reminders 15 min before; escalation after 30 min missed.
- FR-22: Lead timeline: calls, WhatsApp, email, notes, stage and disposition changes, assignments.
- FR-23: Messaging: Interakt WhatsApp templates, Brevo campaigns, Resend email; blocked without channel consent; DNC blocks all.

### 5.6 Telephony: click-to-call, inbound and outbound (no SIP)

**Setup**
- FR-24: Each agent has a registered phone number (mobile or desk phone) and optional provider agent id; each tenant/process has its DIDs (virtual numbers) with direction inbound, outbound or both.
- FR-24a: Admin maps every inbound DID to one process, so an inbound call lands in the right client's pipeline.

**Outbound (click-to-call)**
- FR-25: Agent clicks Call on a lead → CRM checks access, DNC and that the agent has no active call → calls the provider's click-to-call API with agent number, customer number and caller-ID DID → provider rings the agent's phone, then the customer, and bridges.
- FR-25a: A call record is created at click time (`initiated`) with a correlation id; provider webhooks move it through ringing → answered → completed (or agent-no-answer, busy, no-answer, failed).
- FR-25b: While a call is live the lead stays open and a second Call is blocked; after the call ends the disposition is required.
- FR-25c: Provider failures (invalid DID, agent phone unreachable, balance) are shown to the agent in plain words and logged.

**Inbound**
- FR-26: Customer dials a client DID → provider IVR and routing ring an agent's phone (routing is configured in the provider panel) → provider webhooks tell the CRM.
- FR-26a: CRM resolves process from the DID, finds or creates contact and lead by phone, logs the call and pops the lead on the screen of the agent whose phone answered (matched by agent number).
- FR-26b: Missed or unanswered inbound calls create a missed-call record and a callback due now for the lead owner (or next eligible agent); repeat misses from one number on the same day are merged.
- FR-26c: Optional (phase 2, only if the provider supports a routing-lookup webhook): the CRM answers "which agent?" with the lead owner's number, so returning callers reach their own agent.

**Both directions**
- FR-26d: CallerDesk caller-leg recovery ported from `resolveCustomerPhone_`, so the customer number is right even when legs switch.
- FR-26e: Recordings copied from the provider URL to Blob/R2; played only via short-lived signed URLs; every play audit-logged.
- FR-26f: Agent presence shows On call / Wrap-up / Available, driven by call webhooks.

### 5.7 Outbound webhooks and workflows
- FR-27: Admin registers subscriptions: HTTPS URL, event list, filters (process, stage); secret shown once; test-send.
- FR-28: Events: `lead.created`, `lead.assigned`, `disposition.set`, `lead.stage_changed`, `lead.converted`, `lead.lost`, `callback.missed`, `call.completed`, `call.missed`, `backup.completed`, `backup.failed`, `restore.completed`.
- FR-29: Signature header `X-AM2PM-Signature: t=<unix>,v1=<HMAC-SHA256>`; retries ~1m, 5m, 30m, 2h, 12h; auto-pause after 24 h failing.
- FR-30: Workflow engine: trigger → conditions → actions (create task, send WhatsApp template, send email, notify user, update lead, webhook).

### 5.8 Reporting and notifications
- FR-31: Dashboards from `daily_stats`: funnel, agent leaderboard, source performance, callback compliance, time to convert, win/loss, day/week/month comparisons.
- FR-32: Manager digest 09:00 daily; agent weekly report Monday 08:00; CSV export with role-based masking.

### 5.9 Backup and restore (per client)
- FR-33: Nightly encrypted per-tenant backup to a separate R2 bucket; Backup now max once a day.
- FR-34: Backups page: view snapshots, download (fresh 2FA, 15-min URL, if contract allows), export CSV, request restore.
- FR-35: Restore modes: sandbox, selective, full rollback; two-person rule; webhooks muted during restore.
- FR-36: Weekly automated restore test of one random tenant; monthly backup status email to client admins.

### 5.10 Migration
- FR-37: One-off script per spreadsheet maps crmv7 columns, splits Timeline History into `lead_events`, loads dispositions, stages and roster, prints a count reconciliation.

## 6. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Scale | 2,000 agents, many clients, on one Neon Postgres database (autoscaling, read replica for reports) |
| Latency | Webhook ACK < 100 ms p95; lead assigned < 10 s p95; agent screen actions < 500 ms p95; Call click → provider API accepted < 2 s p95; inbound screen-pop < 3 s after the provider's answer webhook |
| Reliability | No lost inbound event (idempotent inbox + DLQ); no lost outbound event (outbox) |
| Isolation | No cross-tenant read, proven by a test on every API route |
| Security | TLS, Neon encryption at rest, Postgres row-level security per tenant, AES-256-GCM for secrets, TOTP 2FA option, audit log |
| Compliance | DPDP Act: Mumbai region, consent per channel, erasure job, retention per tenant, DPA per client |
| Backup | Neon point-in-time restore plus per-tenant nightly export; RPO 24 h (6 h premium), RTO < 1 h per client |
| Cost | Pilot ~$20, growth ~$70–75, scale ~$370–410 per month (provider charges excluded) |
| Portability | Plain Next.js + HTTP queue; can move off Vercel/Upstash if needed |

## 7. Success metrics

| Metric | Target |
| --- | --- |
| Clients off Sheets | 100% by end of week 14 |
| Lead-to-assignment p95 | < 10 s in working hours |
| Duplicate leads created by race | 0 |
| Outbound webhook delivery success (24 h window) | ≥ 99.5% |
| Callback compliance (called within 15 min of due) | Tracked from launch; baseline from crmv7 reports |
| Monthly infra cost at 200 agents | ≤ $90 |
| Per-client restore drill | Passes weekly |

## 8. Release plan

| Phase | Weeks | Scope | Gate |
| --- | --- | --- | --- |
| 1 · Core | 1–6 | Tenancy, users, processes, leads, dispositions, callbacks, agent screen, CSV/form/Sheet import, dedupe, Equal/%/Ratio/Number, CallerDesk click-to-call (outbound) + inbound call webhooks and missed calls, manager digest, nightly per-client backup | Pilot process matches sheet counts daily for 14 days |
| 2 · Automation | 7–10 | Ads + portal connectors, load/skill/sticky, hours and caps, recycle, outbound webhooks, workflows, Interakt/Brevo/Resend | A signed `lead.converted` is verified by a client system |
| 3 · Reporting | 11–14 | Rollups, dashboards, client portal, audit viewer, Backups page, Neon Launch plan with point-in-time restore | All clients off Sheets; Apps Script read-only |
| 4 · Later | 15+ | LMS, attendance, shifts, reimbursements, invoicing, auto-next click-to-call (one call at a time, no SIP), AI call QA | — |

Detailed tasks: [TASK.md](TASK.md).

## 9. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Missed `tenantId` filter leaks a client's data | High | One repository layer, lint rule, cross-tenant test on every route |
| Connection storms from many function instances | Medium | One `pg` pool per instance (max 10) on Neon's pooled URL, `attachDatabasePool` |
| Neon Free has no point-in-time restore | Medium | Move to Launch before the first paying client |
| `open_leads` counter drift | Low | Nightly `recount-open-leads` job |
| QStash retries billed as messages | Low | Idempotent handlers; alert on DLQ growth |
| Vendor lock-in | Low | Plain Next.js + HTTP queue |
| Telephony provider outage or API change | Medium | Provider adapter interface; second click-to-call provider (MyOperator / Exotel) as fallback in phase 4 |
| Agent phone number wrong or unreachable | Medium | Verify agent number with a test call at onboarding; show provider error on the Call button |

## 10. Open decisions

- [x] Database: **Neon Postgres** (decided 2026-10-01; replaces MongoDB Atlas from the v1.1 doc).
- [ ] Agents and leads per day at launch and in 12 months.
- [ ] Which lead sources are live today.
- [ ] Which systems receive `lead.converted`, and what "converted" means per client (disposition, stage or payment).
- [ ] CallerDesk only, or MyOperator / Exotel click-to-call as fallback in v1.
- [ ] Inbound routing: configured only in the provider panel, or CRM routing-lookup (sticky agent) where the provider supports it.
- [ ] Agent phones: personal mobiles or office desk phones; who pays for agent-leg minutes.
- [ ] Recording retention per client contract.
- [ ] Backup retention; may client admins download full backups themselves.
- [ ] Build in-house or with a contractor (plan assumes 2 full-stack developers).
