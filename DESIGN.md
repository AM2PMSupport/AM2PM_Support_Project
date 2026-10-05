# DESIGN — AM2PM Call Center CRM

Detailed design: data model, algorithms, events, API and screens. System shape is in [ARCHITECTURE.md](ARCHITECTURE.md); rules that code must follow are in [RULE.md](RULE.md).

## 1. Data model overview

Neon serverless Postgres, modelled with Drizzle ORM. **`lib/db/schema.ts` is the source of truth**; this section summarises it. Migrations live in `drizzle/`: `0000_init.sql` (tables, foreign keys, indexes) and `0001_rls.sql` (row-level security).

| Group | Tables |
| --- | --- |
| Platform | `tenants` (global) · `users` · `processes` · `user_processes` (M:N) · `integrations` · `telephony_dids` |
| Leads | `contacts` · `leads` · `lead_events` · `import_sources` · `assignment_state` |
| Activity | `interactions` · `dispositions` · `callbacks` |
| Events | `webhook_events` · `outbox` · `webhook_subscriptions` · `webhook_deliveries` · `audit_logs` |
| Planned (T1.26, T2.13, T3.x) | `import_batches` · `workflows` · `workflow_runs` · `daily_stats` · `backup_policies` · `backup_snapshots` · `restore_jobs` · `teams` · `team_members` · `custom_field_definitions` |

### Modelling rules
| Situation | Choice | Example |
| --- | --- | --- |
| Relation between records | Foreign key column + index | `leads.process_id → processes`, `leads.assigned_to → users` |
| Many-to-many | Join table | `user_processes (user_id, process_id)` |
| Unbounded child list | Its own table | `interactions`, `lead_events`, `callbacks` |
| Shape varies per client | JSONB | `leads.custom`, `contacts.consent`, `processes.assignment` |
| Point-in-time snapshot | Copied column | `interactions.agent_name`, `leads.last_disposition` |
| Hot counters | Redis (rebuildable) | live queue length, presence |

Every tenant table has `id uuid` (default `gen_random_uuid()`), `tenant_id uuid` (FK → tenants, default `current_setting('app.tenant_id')`), and `created_at` / `updated_at` (`timestamptz`, UTC). Every tenant index starts with `tenant_id`.

### Core relationships
```
tenants ─< processes ─< leads ─< interactions
   │          │  └─1:1─ assignment_state   ├─< lead_events
   │          ├─< dispositions            └─< callbacks
   │          ├─< import_sources ─< leads.import_source_id
   │          └─< telephony_dids >─ integrations
   └─< users >─< user_processes >─ processes          users ─< leads (assigned_to)
contacts ─< leads ; contacts ─< interactions
outbox ··< webhook_deliveries >─ webhook_subscriptions   (event_id: no FK, outbox is purged sooner)
```

### Tenant isolation (row-level security)
- Tenant code runs inside `withTenant(ctx, fn)`: one transaction whose first statement is `select set_config('app.tenant_id', …, true), set_config('role', 'app_rls', true)` (the second is `SET LOCAL ROLE app_rls`; one statement saves a round trip on every transaction).
- `app_rls` has no BYPASSRLS. Policy on every tenant table: `USING/WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)`.
- `tenants`: `app_rls` may only SELECT its own row. `audit_logs`: `app_rls` may INSERT/SELECT only.
- `lib/platform-admin` uses the owner connection (not subject to RLS) for cross-tenant sweeps.

## 2. Tables

### 2.1 Platform

**tenants** (global): name, slug (unique, used in webhook URLs), status (active, trial, suspended, closed), timezone (default Asia/Kolkata), currency, settings jsonb.

**accounts** (global, platform-only — app role has no access): one login per person. email (unique, lower-cased), password_hash (scrypt), password_changed_at, last_login_at, last_tenant_id (workspace opened after sign-in). See SECURITY.md §3.1.

**users** — a person's *membership* in one workspace (role per workspace)
| Column | Notes |
| --- | --- |
| account_id | FK accounts; unique (tenant_id, account_id); index (account_id) for "my workspaces" |
| email, name | unique (tenant_id, email) |
| role | super_admin, admin, project_supervisor, manager, process_coordinator, trainer, client, agent |
| agent_phone_e164, agent_phone_10, agent_phone_verified_at | the phone that rings for click-to-call and inbound (crmv7 roster "Agent Phone"); index (tenant_id, agent_phone_10) for inbound matching |
| provider_agent_id | agent id in the telephony provider, if it uses one |
| did | outbound caller-ID DID, kept exactly as registered (leading 0) |
| share_weight | Percentage / Ratio weight (crmv7 roster Share) |
| skills text[] | language, city, product tags |
| max_open_leads, open_leads | cap + live counter (conditional increment) |
| daily_quota | Number method |
| is_available | mirrored in Redis presence |
| status | active, inactive, locked |
| password_hash, password_changed_at, last_login_at | scrypt hash (never plain text); index on `email` for sign-in lookup across workspaces |

**user_processes** (M:N): user_id, process_id — mapping an agent here grants access to that process's leads.

**processes** — one campaign for one client.
| Column | Notes |
| --- | --- |
| name, client_tenant_id (FK tenants) | client served |
| stages text[], won_stage | reaching won_stage = converted |
| assignment jsonb | { method, pool?, sticky, workingHours?, slaMinutes, recycleHours?, skillFields? } |
| dedupe_field, re_enquiry_days | "phoneKey" \| "email" \| a custom field key |
| status | active, paused, closed |

**integrations**: kind (telephony, whatsapp, email), provider (callerdesk; myoperator, exotel later; interakt, brevo, resend), credentials_enc and webhook_secret_enc (AES-256-GCM), config jsonb { rateLimitPerMin, routingLookup }, status. Unique (tenant_id, kind, provider).

**telephony_dids**: integration_id, number (as registered, leading 0), number_10 (unique per tenant), process_id, direction (inbound, outbound, both), default_for_outbound. Every inbound DID maps to exactly one process.

**custom fields** (planned table `custom_field_definitions`): entity, process_id, key (immutable), label, type, options, validation, indexed. Values live in the row's `custom` JSONB; a GIN index covers ad-hoc filters, and `indexed` fields get an expression index `(tenant_id, (custom->>'key'))`. Max ~50 per entity.

### 2.2 Leads

**contacts**: name, phone_e164, phone_key (last 10 digits), alt_phone_e164 / alt_phone_key ("Mobile 2": a second callable number; contacts match on either number, an inbound call from Mobile 2 merges into the lead keyed by the main number; click-to-call picks `primary` or `alt`), email (lowercase), consent jsonb { whatsapp, email, sms: { optedIn, at, source } }, dnc, custom jsonb. Indexes (tenant_id, phone_key), (tenant_id, alt_phone_key), (tenant_id, email).

**leads** — one enquiry for one process.
| Column | Notes |
| --- | --- |
| process_id, contact_id | FKs |
| source jsonb, import_source_id | { kind, sourceId, batchId, campaign, adId, formId } |
| stage, status | status open \| won \| lost \| dnc |
| assigned_to, assigned_at | FK users |
| deleted_at, deleted_by | Recycle bin (soft delete, leads **D**): is_active=false frees the dedupe key, pending callbacks cancelled, owner capacity released; Restore refused if another open lead now holds the key. Partial index (tenant_id, deleted_at) WHERE deleted_at IS NOT NULL |
| attempts, last_disposition jsonb | |
| last_interaction_at, next_callback_at, last_enquiry_at, converted_at | queues and SLAs |
| dedupe_key, is_active | unique (tenant_id, process_id, dedupe_key) WHERE is_active |
| custom jsonb | GIN index |

Other indexes: (tenant_id, assigned_to, next_callback_at); (tenant_id, process_id, stage); (tenant_id, contact_id); partial (tenant_id, created_at) WHERE assigned_to IS NULL AND status = 'open' for the sweeper.

**lead_events** — append-only history (replaces crmv7 "Timeline History"): lead_id, type (created, merged, assigned, reassigned, stage_changed, disposition_set, callback_set, converted, lost, restored), actor jsonb, before/after jsonb.

**import_sources**: kind (web_form, meta_ads, google_ads, indiamart, justdial, csv, sheet, api), process_id, field_map jsonb, secret_hash (SHA-256; key shown once), status, last_lead_at.

**assignment_state** (PK process_id): seq, smooth_weights jsonb, day, daily_counts jsonb. Locked `FOR UPDATE` while assigning.

**saved_views**: user_id, module ('leads'), name, query jsonb (the Leads screen URL params), shared (visible to the whole workspace; admins only). Index (tenant_id, module, user_id).

### 2.3 Activity

**interactions** — calls, WhatsApp, SMS, email, notes.
| Column | Notes |
| --- | --- |
| type, direction | call, whatsapp, email, sms, note · inbound, outbound |
| lead_id, contact_id, process_id, agent_id, agent_name | FKs + name snapshot |
| status | outbound call: initiated, agent_ringing, agent_no_answer, customer_ringing, answered, busy, no_answer, failed, completed, unknown · inbound: ringing, answered, missed, completed |
| started_at, ended_at, duration_sec, talk_sec | |
| provider, provider_call_id, correlation_id | unique (tenant_id, correlation_id); unique (tenant_id, provider, provider_call_id) |
| did, agent_number, customer_number, hangup_by, end_reason | call details |
| recording_url, recording_key | provider URL (never shown) → Blob/R2 key |
| disposition jsonb, notes | wrap-up |

**dispositions**: process_id (null = tenant-wide), code (immutable), label, category (positive, negative, neutral, callback, dnc, converted), actions jsonb, sort_order, is_active. Unique (tenant_id, process_id, code). Default set from crmv7: Interested, Not Interested, Call Back, No Answer, …; stages Hot, Warm, Cold. Callback detection matches `call.?back` / `follow.?up`.

**callbacks**: lead_id, assigned_to, due_at, channel, status (pending, done, missed, escalated, cancelled), reason, day, reminded_at, escalated_to. Unique (tenant_id, lead_id, day) WHERE reason = 'missed_call' → at most one missed-call callback per lead per tenant-local day.

### 2.4 Events

| Table | Key columns | Indexes / retention |
| --- | --- | --- |
| `webhook_events` | source, idempotency_key, payload jsonb, status (received, processing, done, failed, dead), attempts, error | unique (tenant_id, source, idempotency_key); purged after 60 d |
| `outbox` | event_type, entity_id, payload jsonb, published_at | partial index WHERE published_at IS NULL; purged 30 d after publish |
| `webhook_subscriptions` | url (HTTPS), events text[], filters jsonb {processIds, stages}, secret_enc, is_active, failing_since | (tenant_id, is_active) |
| `webhook_deliveries` | subscription_id, event_id, event_type, status, attempts jsonb (last 6) | unique (subscription_id, event_id); purged after 90 d |
| `audit_logs` | actor_id, action, entity, entity_id, before, after, ip | insert-only for app_rls |
| `backup_*`, `restore_jobs`, `daily_stats`, `workflows`, `workflow_runs` | as in the v1.1 design doc, with snake_case columns | planned |

### 2.5 Indexing and quick search

Every query the app runs has an index built for it. Rules: tenant-scoped indexes start with `tenant_id`; partial indexes cover hot subsets (open, pending, unpublished); search uses trigram GIN indexes (`pg_trgm`) made tenant-first with `btree_gin` (`drizzle/0002_search_extensions.sql`). Definitions live in `lib/db/schema.ts`; the planner checks are in `tests/integration/search.test.ts`.

**Quick call lookup**

| Query | Index | Type |
| --- | --- | --- |
| Match a webhook to our call (correlation id) | `interactions_correlation` (tenant_id, correlation_id) | unique, partial |
| Match by provider call id | `interactions_provider_call` (tenant_id, provider, provider_call_id) | unique, partial |
| Fallback match: agent's latest call to a customer | `interactions_agent_customer` (tenant_id, agent_number, customer_number, started_at) | btree |
| Caller history / screen-pop by phone | `interactions_customer` (tenant_id, customer_number, started_at) | btree |
| Inbound caller → contact | `contacts_tenant_phone` (tenant_id, phone_key); Mobile 2 via `contacts_tenant_alt_phone` | btree |
| Inbound DID → process | `dids_tenant_number10` (tenant_id, number_10) | unique |
| Answering agent by phone | `users_tenant_phone10` (tenant_id, agent_phone_10) | btree |
| Lead timeline | `interactions_lead` (tenant_id, lead_id, started_at) | btree |
| Agent call history | `interactions_agent` (tenant_id, agent_id, started_at) | btree |
| Stuck-call sweeper | `interactions_initiated` (started_at) WHERE status = 'initiated' | partial |

**Quick search** (`searchContacts()` in `lib/leads/search.ts`; runs on a read replica)

| User types | Routed to | Index |
| --- | --- | --- |
| `rahul@gm`, `@example.org` | email ILIKE `%…%` | `contacts_search_email` (GIN trigram) |
| `+91 98111 14321` (10+ digits) | phone_key = last 10 digits | `contacts_tenant_phone` (btree, exact) |
| `4321`, `98111` (3–9 digits) | phone_key ILIKE `%…%` | `contacts_search_phone` (GIN trigram) |
| (both phone rows) | also alt_phone_key — Mobile 2 | `contacts_tenant_alt_phone` / `contacts_search_alt_phone` |
| `Rah`, `sharma` | name ILIKE `%…%`, ranked by `similarity()` | `contacts_search_name` (GIN trigram) |
| 1 character / 1–2 digits | no search (too vague) | — |

Wildcards in user input (`%`, `_`) are escaped. Results include each contact's active leads and respect RLS.

Measured on Postgres (PGlite): at ~10K contacts the planner prefers the plain tenant index and search takes ~3–5 ms; from ~100K contacts it switches to the trigram indexes, ~1.4–3.4 ms. Both are well under the 500 ms screen target.

**Queues, sweeps and jobs**

| Query | Index |
| --- | --- |
| Dedupe on insert | `leads_dedupe_active` (tenant_id, process_id, dedupe_key) WHERE is_active — unique |
| Agent queue: my leads by next callback | `leads_owner_callback` (tenant_id, assigned_to, next_callback_at) |
| Open-lead counts / nightly recount | `leads_open_by_owner` (assigned_to) WHERE status = 'open' |
| Unassigned sweeper | `leads_unassigned` (tenant_id, created_at) WHERE assigned_to IS NULL AND status = 'open' |
| Leads by stage (pipeline views) | `leads_process_stage` (tenant_id, process_id, stage) |
| Custom-field filters | `leads_custom_gin` GIN (custom) |
| Callback reminders (platform cron) | `callbacks_pending_due` (due_at) WHERE status = 'pending' |
| Agent's due callbacks | `callbacks_owner` (tenant_id, assigned_to, status, due_at) |
| One missed-call callback per day | `callbacks_missed_once_a_day` unique partial |
| Webhook idempotency | `webhook_events_idem` (tenant_id, source, idempotency_key) — unique |
| Outbox relay | `outbox_unpublished` (created_at) WHERE published_at IS NULL |
| Retention purge | `webhook_events_created`, `webhook_deliveries_created` (created_at) |

**Adding an index:** add it in `lib/db/schema.ts` → `npm run db:generate` → review the SQL → `npm run db:migrate`. Check with `EXPLAIN (ANALYZE)` on realistic volume (a 3-row table proves nothing: the planner is cost-based). For large tables in production, create the index `CONCURRENTLY` in a hand-written migration to avoid blocking writes.

## 3. Lead pipeline

### 3.1 Sources
| Source | How it arrives | Notes |
| --- | --- | --- |
| Website / landing forms | `POST /api/hooks/{tenant}/{sourceId}` + source key | field map per source |
| Meta Lead Ads | leadgen webhook → Graph API fetch by id | one Meta app for AM2PM; each client connects its page |
| Google Ads lead forms | lead-form webhook + shared key | key stored hashed |
| IndiaMART, Justdial | push where offered, else 15-min pull with cursor | |
| CSV / Excel | Blob upload → QStash, 500 rows per message | per-row report |
| Google Sheet | 15-min pull of rows after last synced row | migration bridge |
| Public API | `POST /api/v1/leads` + tenant API key | returns lead id + assignee |

### 3.2 Normalise
- Apply `fieldMap`; unmapped fields → `custom`.
- Phone → E.164 + `phoneKey` = last 10 digits; valid Indian mobile = `^[6-9]\d{9}$` (crmv7 `toTenDigits` / `isValidMobile10`).
- Reject rows with no valid phone and no email; log in batch report.
- Stamp `source {kind, sourceId, campaign, adId}`.

### 3.3 Dedupe
```sql
-- inside withTenant(): one transaction
insert into leads (process_id, contact_id, dedupe_key, ...) values (...)
on conflict (tenant_id, process_id, dedupe_key) where is_active do nothing
returning id;
-- a row back  → created: insert lead_events(created) + outbox(lead.created), queue "assign-lead"
-- no row back → merge:   update leads set last_enquiry_at = now() ... ; lead_events(merged); alert owner
```
`dedupe_key` = the lead's phone key by default; email or a custom field per process (`processes.dedupe_field`). `ON CONFLICT` is used instead of catching the error because an error inside a Postgres transaction aborts it. After `re_enquiry_days` a closed lead gets `is_active = false`, so a repeat creates a new lead.

## 4. Auto-assignment

**Eligibility (in order):** status active → mapped in `user_processes` (SQL join) → `is_available` → clocked in and not on break / leave in Jibble (T2.22, per-process toggle, off by default) → inside working hours (tenant TZ) → `openLeads < maxOpenLeads` → under today's quota (Number) → skills match (Skill). Eligible list cached 30 s in Redis per process.

| Method | Pick |
| --- | --- |
| Equal | next eligible agent after `seq` |
| Percentage / Ratio | smooth weighted round-robin on `shareWeight` |
| Number | fixed daily quota per agent, then skip |
| Load-based | fewest `openLeads` |
| Skill / language / city | only agents whose tags match lead fields |
| Sticky owner | returning contact → previous owner if eligible (falls back to process method) |

**Smooth weighted round-robin** (A:50, B:30, C:20 → A B A C A B A …):
```ts
for (const u of eligible) state.smoothWeights[u] = (state.smoothWeights[u] ?? 0) + weight[u];
const pick = argmax(eligible, u => state.smoothWeights[u]);
state.smoothWeights[pick] -= sum(eligible.map(u => weight[u]));
```

**Atomic pick (one transaction, retry next agent ≤ 3):**
1. `select … from leads where id = $1 for update` — a second worker for the same lead waits, then sees it assigned.
2. `select … from assignment_state where process_id = $1 for update` — one assignment at a time per process.
3. `update users set open_leads = open_leads + 1 where id = $pick and open_leads < max_open_leads returning` — no row = full; try the next candidate.
4. Save the new state; `update leads set assigned_to, assigned_at`; insert `lead_events` (assigned) + `outbox` (`lead.assigned`).

**Edge cases:** none eligible → sweeper every 5 min, supervisor alert after `slaMinutes`; recycle after `recycleHours` untouched; agent leaves → open leads back to pool; `open_leads` decrements on won/lost/DNC/reassign; nightly `recount-open-leads` job.

## 5. Telephony (click-to-call, no SIP)

All calls go through the provider's REST click-to-call API and webhooks. There is no SIP, PBX, WebRTC or browser audio in this system.

### 5.1 Adapter interface
```ts
interface TelephonyAdapter {
  clickToCall(i: { agentNumber: string; customerNumber: string; callerId: string; correlationId: string }):
    Promise<{ ok: true; providerCallId?: string } | { ok: false; code: string; message: string }>;
  verifyWebhook(req: Request, secret: string): Promise<boolean>;
  parseWebhook(body: unknown): NormalisedCallEvent[];      // one webhook may carry several events
  routeLookup?(i: { did: string; customerNumber: string }): { agentNumber?: string }; // optional
}

type NormalisedCallEvent = {
  kind: "agent_ringing" | "agent_answered" | "agent_no_answer" | "customer_ringing" | "answered"
      | "busy" | "no_answer" | "failed" | "completed" | "missed" | "recording_ready";
  direction: "inbound" | "outbound";
  providerCallId?: string; correlationId?: string;
  did: string; customerNumber: string; agentNumber?: string;
  at: Date; durationSec?: number; talkSec?: number; recordingUrl?: string; hangupBy?: "agent" | "customer" | "system";
};
```
The CallerDesk adapter ports crmv7's `canonicalDid`, 10-digit number format and `resolveCustomerPhone_` caller-leg recovery. MyOperator and Exotel adapters come in phase 4.

### 5.2 Outbound state machine
```
initiated → agent_ringing → customer_ringing → answered → completed
    │            └→ agent_no_answer (agent didn't pick up)
    │                          └→ busy | no_answer | failed (customer side)
    └→ failed (API rejected)            no webhook in 10 min → unknown (sweeper)
```
- `answered` → `leads.attempts + 1`, agent presence On call.
- Terminal state → release `call:active:{userId}`, presence Wrap-up, disposition required.
- `agent_no_answer` does not count as a customer attempt.

### 5.3 Inbound handling
1. DID → process from `telephony_dids` (matched on `number_10`); unknown DID → log to `webhook_events` as `failed` and alert admin.
2. Recover the real caller number; normalise to `phoneKey`.
3. Find/create contact and lead (dedupe rules apply; an inbound call is a lead source `kind: inbound_call`).
4. Answering agent = user whose `agent_phone_10` matches the webhook's agent number; screen-pop to them. Unknown yet → pop to lead owner + process queue.
5. Missed: interaction `missed`; callback due now for owner (or next eligible agent via assignment); one callback per number per day (crmv7 `missedCallDateKey_` rule); outbox `call.missed`.

### 5.4 Guards
- One live call per agent (Redis `SET call:active:{userId} NX EX 900`).
- Call blocked if contact is DNC, agent lacks `agent_phone_e164` or a DID, or the lead is outside the agent's scope.
- Per-tenant API rate limit from `config.rateLimitPerMin`.
- Webhooks are idempotent on `{provider, providerCallId, kind}`.

## 6. Events and webhooks

### 6.1 Event catalogue
| Event | Fires when | Typical receiver |
| --- | --- | --- |
| `lead.created` | any import or manual create | Slack, ad-platform offline conversions |
| `lead.assigned` | auto or manual assignment | agent alert |
| `disposition.set` | agent saves a call outcome | client BI |
| `lead.stage_changed` | stage moves | nurture tool |
| `lead.converted` | disposition category converted, or stage = wonStage | ERP/billing, Meta/Google conversion API |
| `lead.lost` | negative or DNC disposition closes lead | retargeting removal |
| `callback.missed` | due + 15 min, no call | supervisor |
| `call.completed` | a click-to-call or inbound call ends (answered) | QA tool |
| `call.missed` | inbound call not answered | supervisor, "sorry we missed you" WhatsApp |
| `backup.completed` / `backup.failed` | tenant backup finishes | client IT, AM2PM ops |
| `restore.completed` | restore job finishes | client admin |

### 6.2 Payload and signature
```http
POST https://client.example.com/crm-hook
X-AM2PM-Signature: t=1790812345,v1=5f2c...e91
Content-Type: application/json

{ "id": "evt_6701c2...", "type": "lead.converted", "tenant": "flo-mattress",
  "occurredAt": "2026-10-01T09:14:05Z",
  "data": { "leadId": "...", "process": "Flo Mattress - Sales",
            "contact": { "name": "Rahul S", "phone": "+9198XXXX4321" },
            "disposition": { "code": "SALE", "label": "Order placed" },
            "agent": { "id": "...", "name": "Rohit Kumar" },
            "source": { "kind": "meta_ads", "campaign": "Diwali-26" },
            "custom": { "mattress_size": "Queen", "budget": 25000 } } }
```
`v1 = HMAC-SHA256(secret, t + "." + rawBody)` hex. Receivers reject if `|now − t| > 300 s` and compare with `timingSafeEqual`.

Delivery: retries ~1m, 5m, 30m, 2h, 12h via QStash; 2xx = delivered; each attempt in `webhook_deliveries`; 24 h failing → auto-pause + email admin.

## 7. Access control

Scopes applied in queries: `own` (assigned_to = me) · `team` (assigned_to ∈ my teams' users) · `process` (process_id ∈ my `user_processes`) · `tenant` (enforced by RLS) · `global` (Super Admin, audit-logged). Client role = process scope limited to processes where `clientTenantId` = their tenant.

Legend: V view · C create · E edit · D delete · A approve · X export · I import.

**Editable per workspace** (2026-10-05, MEMORIE.md): the table below is the default. A Super Admin can change any cell for their workspace in Setup → Roles — changes are a draft (unsaved cells ringed) until **Save**, which writes them all in one transaction; **Cancel** drops the draft; **Default** puts every role's module access and permissions back to the defaults (then Save); edits are stored in `role_permissions` (only cells that differ from the default) and applied to every check via the actor's `grants` (lib/auth/grants.ts → lib/auth/rbac.ts `can(who, …)`). Super Admin's column is locked. Data scope below (own / process / tenant) is fixed per role and not editable.

**Module access** (2026-10-05): above the matrix, Setup → Roles has one switch per role × sidebar module (Console, Leads, Calls, Floor, Setup, Coming soon), stored as `role_permissions` rows `screen.<name>` (`V` on, `""` off). Defaults reproduce the old sidebar: on wherever the role's permissions can use the module, except Floor for agents and Console/Leads/Calls for clients. A module shows only when switched on **and** the role's permissions can use it (`navAvailable()` → `navFor()`). Ticking any box (except Super Admin's) works: if the role lacks the permission the module needs (`SCREEN_NEEDS`: Console/Leads → leads, Calls → interactions, Floor → reports, Setup → config), the same save grants View on it. Page guards (`requirePage`) and the post-switch landing use the same list.

Lead scope for client, trainer, HR and accounts is `process` (the processes they're mapped to): it only matters once a Super Admin grants them lead or call rights.

Reassigning leads (bulk "Assign to…", choosing an owner on Create Lead) = `E` on leads **and** a scope wider than own (`canReassign()` in lib/auth/rbac.ts) — admins, supervisors, managers, coordinators; never agents.

| Module | Super Admin | Admin | Supervisor | Manager | Coordinator | Client | Agent | HR | Auditor | Accounts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tenants / config | VCEDAX | VCE | V | V | – | – | – | – | – | – |
| Users | VCEDAXI | VCEDXI | VE | VE | V | – | own | V | – | – |
| Leads | VCEDAXI | VCEDXI | VCEAX | VCEAX | VCE | V (process) | VE (own) | – | VX (tenant) | – |
| Interactions | VX | VX | VX | VX | V | V (masked) | VC (own) | – | VX (masked) | – |
| Callbacks | VCEDX | VCEDX | VCEA | VCEA | VCE | – | VCE (own) | – | V | – |
| Import sources | VCED | VCED | V | V | – | – | – | – | – | – |
| Webhooks / workflows | VCEDX | VCED | VE | V | – | – | – | – | – | – |
| Reports | VX | VX | VX | VX | V | V (assigned) | own | – | VX | VX |
| Integrations | VCED | VCE | – | – | – | – | – | – | – | – |
| Backups | VCEDAX (restore any) | VCX + request restore | V | V | – | V + download (if allowed) | – | – | – | – |
| Audit logs | V | V | – | – | – | – | – | – | V | – |
| Employees (T1.49) | VCEDAXI | VCEDXI | V | V | – | – | – | VCEDAXI | – | – |
| Billing (T1.50) | VCEDAXI | V | – | – | – | – | – | – | – | VCEDAXI |

Trainer: LMS only (phase 4); default Reports V. CSV import = `I` on Leads. HR and Accounts see no leads (scope none); Auditor sees every lead in the workspace read-only (scope tenant, phones masked).

## 8. API surface

| Method + path | Purpose | Auth |
| --- | --- | --- |
| `POST /api/hooks/{tenant}/{sourceId}` | lead source webhook | source key / signature |
| `POST /api/hooks/{tenant}/telephony/{provider}` | inbound + outbound call webhooks, recordings | provider signature / shared secret |
| `POST /api/hooks/{tenant}/telephony/{provider}/route` | optional routing lookup (answers inline, within provider timeout) | provider signature |
| `POST /api/hooks/{tenant}/interakt\|brevo\|resend` | message status | provider signature |
| `POST /api/v1/leads` | create lead (client CRM, partner) | tenant API key |
| `GET /api/v1/leads?stage=&assignedTo=&cursor=` | list, cursor pagination | session / API key |
| `PATCH /api/v1/leads/{id}` | stage, custom fields | session |
| `POST /api/v1/leads/{id}/disposition` | save outcome (+ callback) | session (agent) |
| `POST /api/v1/leads/{id}/call` | click-to-call: returns `{ interactionId, status }`; 409 if agent already on a call | session (agent) |
| `GET /api/v1/calls/active` | agent's live call (for page reloads) | session (agent) |
| `POST /api/v1/users/{id}/verify-phone` | test click-to-call to the agent's own phone | session (admin) |
| `POST /api/v1/imports` | upload CSV → batch id | session (admin) |
| `CRUD /api/v1/webhook-subscriptions` | manage outbound webhooks; test-send | session (admin) |
| `GET /api/v1/backups` | list snapshots | session (admin) |
| `POST /api/v1/backups` | backup now (1/day) | session (admin) |
| `POST /api/v1/backups/{id}/download` | 15-min signed URL | session (admin) + fresh TOTP |
| `POST /api/v1/restores` | request restore | session (admin) |
| `POST /api/v1/restores/{id}/approve` | second approver starts job | session (super admin) |
| `GET /api/v1/stream` | SSE: new leads, inbound screen-pop, call status changes | session |
| `POST /api/jobs/*` | QStash consumers | QStash signature |
| `GET /api/cron/*` | Vercel Cron entry points | `CRON_SECRET` |

Errors: JSON `{ error: { code, message } }`; list endpoints return `{ items, nextCursor }` (keyset pagination on `(created_at, id)`).

## 9. Screens

| Area | Screen | Key elements |
| --- | --- | --- |
| Agent | My queue | callbacks due, missed inbound calls, fresh, recycled; live counter; availability toggle; status Available / On call / Wrap-up |
| Agent | Inbound screen-pop | toast + auto-open of the caller's lead (or new-lead form) when an inbound call is answered on the agent's phone |
| Agent | Lead workspace | queue filter (search name/city/phone digits/outcome · stage · source · tabs) with Prev/Next "3 of 8" through the filtered list; Details grid shows EVERY field (name, mobile, email, campaign, stage, owner, custom fields, extra imported columns, "Add a detail") editable in place — dropdowns for stage/owner/dropdown & yes-no fields, one field per save; "End that call" clears the agent's own stuck call (no provider webhook); contact card (masked per role), **Call** button ("Calling your phone…" → Ringing customer → Connected mm:ss → Ended), no dial pad or audio in the browser, disposition + sub-disposition (can be picked, noted and saved while the call is still ringing or connected — it lands on that call), callback quick picks (Today 6 PM, Tomorrow, +2 days…), stage, custom fields, timeline, WhatsApp/email send (consent-gated) |
| Everyone | Workspace switcher | avatar / workspace badge in the rail → profile panel listing every workspace the login belongs to (role per workspace); super admins also see "Enter" for the rest. Switching changes everything: setup, leads, telephony, people (SECURITY.md §3.1) |
| Manager | Leads (Zoho-style, built 2026-10-02) | filter rail (saved filters personal/shared, system filters: my leads, unassigned, not called, callback overdue/today, re-enquired; status, stage, source, owner, process, created — with counts), sort (newest, oldest, name, next callback, last activity), list or board (by stage, drag to move), manage columns + records per page (25/50/100), bulk assign / move stage / delete / restore, row actions Edit + Delete pinned right with Lead name pinned left, table settings (Manage Columns, Reset Column Size, Records Per Page, View Mode wrap/clip, drag-to-resize columns), Prev/Next keyset paging with page x of y, Recycle bin, Edit opens the full-page lead record `/leads/{id}` (2026-10-05: contact, Mobile 2, stage, owner, campaign, every custom field + extra column editable; every system column read-only; timeline + call history with recordings; phone only for roles that see full numbers; read-only without leads E), Create Lead drawer (dedupe-aware), CSV export (X permission) |
| Everyone with calls | Calls (built 2026-10-03) | call log in scope: when (tenant tz), in/out, lead, number (masked per role), agent, result, duration, talk time, outcome; filters (today/7d/30d/all, direction, result, agent, with recording, name/digits); totals strip; ▶ inline player per call (and in the console timeline); "Sync now" (supervisors+) + automatic 15-min sync from CallerDesk |
| Manager | Team dashboard | live agents, open/unassigned leads, SLA breaches, reassign |
| Manager | Reports | funnel, leaderboard, source performance, callback compliance, time to convert, win/loss, period comparisons, CSV export |
| Admin | Setup home (built 2026-10-02) | searchable grid: General (company settings, users, workspaces) · Security (roles & permissions, audit log, login history) · Channels (telephony, lead sources, webhooks) · Customization (processes, outcomes & fields) · Automation (assignment, reminders/SLA) · Data (import, export, remove sample data) · Training (planned). Planned items shown greyed with their phase |
| Admin | Processes | stages, won stage, dispositions, assignment method + weights + caps + hours, dedupe rule |
| Admin | Sources | add source, field-map editor, key shown once, health, CSV import with batch report |
| Admin | Users and teams | roster (share, agent phone + Verify test call, DID, skills, caps), process mapping |
| Admin | Telephony | provider credentials, DIDs → process and direction, default outbound DID, webhook URL to paste into the provider, last webhook received, test call |
| Admin | Webhooks | subscriptions, event picker, secret once, test-send, delivery log, failed events + Replay |
| Admin | Backups | snapshots, backup now, download (2FA), export CSV, request restore |
| Everyone | Coming soon (built 2026-10-05) | "Soon" in the rail → `/soon` hub of planned modules (reports, campaigns, workflows, attendance, employees, billing, client portal, training, backups, connectors, AI call quality) → `/soon/{module}` with plan position, audience, features and a preview on fictional sample data. Catalogue in `lib/ui/coming-soon.ts`; reads no tenant data. When a module ships, remove its entry |
| Everyone | 404 (built 2026-10-05) | `app/not-found.tsx`: the AM2PM clock as the "0" in 404, dizzy (cross eyes, wobble, spinning hand, sweat drop; still under reduced motion), "This page clocked out.", Take me home. Shown for unknown URLs AND for modules / Setup tabs the role can't open (SECURITY.md §3.3) |
| Super Admin | Tenants, restore approvals, platform health | |
| Client portal | Processes, leads (masked), assigned reports, backups (if allowed) | |

UI stack: Next.js App Router, React Server Components, Tailwind CSS + shadcn/ui. Every date shown in the tenant timezone; stored in UTC.

### 9.1 Visual design (built 2026-10-01)

| Element | Decision |
| --- | --- |
| Feel | Operations console, not a marketing page: warm paper `#F5F3EE`, ink `#15171C`, 1px hairline rules, dense tables, no gradients / glass / shadow cards |
| Brand colour = meaning | Teal `#6BD3DC` (from the logo) = live, connected, active · Orange `#F56332` = overdue, missed, SLA breach, failing |
| Type | Schibsted Grotesk (UI) + JetBrains Mono (phones, timers, counts — tabular numbers) |
| Signature details | Live IST shift clock; the logo's clock arc reused as SLA rings (queue) and capacity rings (agents); click-to-call stepper (your phone → customer → connected → ended) |
| Keyboard | `J`/`K` queue, `C` call, `1–8` outcome, `Enter` save, `/` search |
| Charts | Hand-drawn SVG, direct labels, no chart library |
| Code | `app/globals.css` tokens (Tailwind v4 `@theme`), `components/`, sample data in `lib/ui/sample-data.ts` (shapes mirror the DB) |

Screens: `/login`, `/console`, `/leads`, `/dashboard` (Floor), `/admin` (Setup) — all on live data since 2026-10-02. `/soon` (Coming soon) is sample data by design.

## 10. crmv7 → new system mapping

| crmv7 | New |
| --- | --- |
| `Marketing_Leads` + Sync | `import_sources` (sheet) + 15-min pull |
| `CRM_Calling` row | `leads` + `contacts` |
| Assigned To / Lead Disposition / Lead Stage / Remark / Callback Date-Time | `assigned_to` / `last_disposition` + interaction / `stage` / interaction `notes` / `callbacks` |
| Timeline History cell | `lead_events` |
| Config dropdowns | `dispositions`, `processes.stages` |
| Config user roster (Name, Email, Share, Agent Phone, DID) | `users` (shareWeight, phone, did) |
| Lead Assignment Method / Auto-Assign toggle | `processes.assignment` |
| Remove Duplicates / Duplicate Check Column | `processes.dedupe` |
| `CRM_WebhookLog` / `CRM_Inbound` / `MissedCalls` | `webhook_events` / inbound `interactions` / missed-call `interactions` + `callbacks` |
| 📞 Call checkbox + `CRM_CallLog` (CallerDesk `click_to_call_v2`) | Call button → `POST /leads/{id}/call` → adapter `clickToCall` + interaction |
| Roster "Agent Phone" (calling_party_a) / DID columns | `users.agent_phone_e164` / `users.did` |
| 💬 WA, 🟢 Interakt, 📧 Email, 📨 Brevo, 📮 Resend + logs | messaging adapters + interactions |
| Opt-in column / Require Opt-In | `contacts.consent` |
| Report builders (`rpt*`) | `daily_stats` + dashboards |
| Time triggers | Vercel Cron (ARCHITECTURE §4) |

## 11. Workforce tracking (Jibble, planned T2.18–T2.29)

Owner request 2026-10-05 (MEMORIE.md). Jibble stays the place people clock in; the CRM reads it and joins it with call data.

**Jibble API facts** (docs.api.jibble.io, read 2026-10-05): OAuth2 client credentials at `identity.prod.jibble.io/connect/token` (token acts as the key's creator — use an Owner/Admin key); OData REST on `workspace.prod.jibble.io` (People, Groups, Positions, Locations + geofence, Schedules, Activities, Projects, Clients, Calendars, TimeOffPolicies), `time-tracking.prod.jibble.io` (TimeEntries In/Out with time, belongsToDate, project, activity, location, coordinates, device; GetCurrentTotalsForScope; People latest entry; Screenshots; TimeOffIntervals; LeaveBalances), `time-attendance.prod.jibble.io` (Timesheets, TimesheetsSummary, PayPeriodSummary/Details, TrackedTimeReport, attendance export). `Prefer: respond-async` for large collections. **No webhooks**; rate limits unpublished (export concurrency → 429).

**Data (planned):**

| Table | Key columns | Notes |
| --- | --- | --- |
| `workforce_integrations` | tenantId (the AM2PM platform workspace), credentialsEnc, lastCursor, lastSyncAt | one Jibble org; secret envelope-encrypted, never returned |
| `employee_links` | accountId, jibblePersonId, code, group, position, managerIds, status | email match; unmatched rows listed for manual link |
| `attendance_events` | jibbleEntryId (unique), accountId, type In/Out/Break, at, belongsToDate, locationId, outsideGeofence | `ON CONFLICT DO NOTHING` on jibbleEntryId (polls overlap) |
| `attendance_days` | accountId, date, firstIn, lastOut, workedSec, breakSec, lateMin | rollup joined with `daily_stats` for the agent sheet |

**Rules:** only through the adapter (RULE §10); poll ≤ every 5 min on the existing sweep; presence in Redis lives 10 min (longer than the poll) and stale presence counts as "unknown", so attendance-aware assignment falls back to ignoring attendance instead of assigning nobody; one person = one account across workspaces, so attendance attaches to `accounts`, and each workspace sees only its own members' rows; screenshots and coordinates are shown only to HR / Auditor / Admin and are off by default; CRM → Jibble writes (T2.29) only when the opt-in is on.

**Screens:** Floor gets an attendance column and mismatch alerts (T2.20–T2.21); Reports → Agent day / Productivity (T2.23–T2.24); HR → Employees and leave (T1.49, T2.25); Accounts → Billable hours (T2.27); Auditor → Attendance audit (T2.28).

