# API

HTTP interface of the AM2PM CRM. **Implemented** endpoints are live in `app/api/`; **planned** ones are designed in [DESIGN.md §8](DESIGN.md#8-api-surface) and listed here so clients and developers see the whole contract.

Base URL (production): `https://am2pmsupportproject.vercel.app`

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Format | JSON in and out (`Content-Type: application/json`). Lead-source and telephony webhooks also accept form-encoded bodies and query parameters. |
| IDs | UUID v4 strings |
| Time | ISO 8601 UTC (`2026-10-01T09:14:05Z`); the UI converts to the tenant timezone |
| Errors | `{ "error": { "code": "<stable_code>", "message": "<safe to show>" } }` with a matching HTTP status. Codes are stable; messages may change. |
| Lists (planned) | `{ "items": [...], "nextCursor": "<opaque>" }`; pass `?cursor=` for the next page. No offset paging. |
| Tenancy | Never sent in a body. It comes from the session, or from `{tenant}` (the tenant slug) in webhook URLs. |
| Idempotency | Webhooks: provider event id or SHA-256 of the body. Outbound events: stable `id` for receivers to dedupe. |

### Common error codes

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Malformed input (e.g. invalid UUID) |
| 401 | `unauthorized` | Missing/invalid key, signature or cron secret |
| 401 | `unauthorized` / `invalid_credentials` | Not signed in / wrong email or password |
| 403 | `forbidden`, `dnc` | Not allowed / contact is on Do Not Call |
| 404 | `not_found` | Unknown tenant, source, lead or route |
| 409 | `conflict`, `already_on_call` | State conflict |
| 422 | `no_phone`, `no_agent_phone`, `no_telephony`, `no_did` | Setup missing for this action |
| 500 | `internal` | Unexpected error (details only in server logs) |
| 502 | provider codes (see §3.1) | The telephony provider rejected the request |

## 2. Authentication

| Caller | Mechanism | Used by |
| --- | --- | --- |
| People (agents, managers, admins, clients) | Signed session cookie `am2pm_session` from `POST /api/auth/login` (email + password). Google / OTP / TOTP may be added later | `/api/v1/*`, `/api/graphql`, app screens |
| Integrations, partners, client CRMs | **API key** `Authorization: Bearer am2pm_…` (Setup → API keys; shown once, SHA-256 stored). Acts as the admin who created it — same role, scope (RLS) and audit trail. Scope `read` (GET + GraphQL queries) or `write` (also creates/updates/deletes; else `403 read_only_key`). Rate limit **600 requests/min per key** → `429 rate_limited`. Revoked/unknown key → `401 invalid_api_key` | `/api/v1/*`, `/api/graphql` |
| Lead sources | Source key in header `x-source-key` (or `?key=`), shown once when the source is created | `/api/hooks/{tenant}/{sourceId}` |
| Telephony provider | Per-tenant webhook secret in the URL path `/{key}` (current) or `?key=` (older URLs); CallerDesk sends no signature | `/api/hooks/{tenant}/telephony/{provider}/{key}` |
| QStash (internal) | `Upstash-Signature` header, verified with current + next signing keys | `/api/jobs/*` |
| Vercel Cron (internal) | `Authorization: Bearer $CRON_SECRET` | `/api/cron/*` |

## 3. Implemented endpoints

### 3.0 `POST /api/auth/login` · `POST /api/auth/logout`

Email + password sign-in. Body `{ "email": "…", "password": "…" }`.

**200** `{ "ok": true, "role": "agent", "name": "Demo Agent", "workspace": "AM2PM Support", "home": "/console" }` + `Set-Cookie: am2pm_session=…; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `bad_request` | Missing / invalid email or password |
| 401 | `invalid_credentials` | Wrong email or password (same message for both) |
| 429 | `too_many_attempts` | 5 failures for this email or 30 from this IP in 15 min |

The login is one per person across workspaces (SECURITY.md §3.1); sign-in opens the workspace used last, and the in-app switcher re-issues the cookie for another membership. Cookies issued before 2026-10-02 (no login id) are rejected once — sign in again.

`/api/auth/logout` clears the cookie. All `/api/v1/*` routes and the app screens require this cookie; screens redirect to `/login` without it.


### 3.1 `POST /api/v1/leads/{id}/call` — click-to-call (session or `write` API key)

The agent's **Call** button. API click-to-call only, no SIP: the provider rings the agent's registered phone first, then the customer, and bridges them. Live status then arrives from provider webhooks.

- Auth: session (agent or above).
- Body: none.

**202 Accepted**
```json
{ "interactionId": "3f0c…-uuid", "status": "initiated" }
```

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `bad_request` | `id` is not a UUID |
| 403 | `forbidden` | Agent calling a lead not assigned to them |
| 403 | `dnc` | Contact or lead is Do Not Call |
| 404 | `not_found` | Lead not found (or belongs to another tenant) |
| 409 | `already_on_call` | Agent already has a live call |
| 422 | `no_phone` / `no_agent_phone` / `no_telephony` / `no_did` | Contact phone, agent phone, provider or caller-ID DID missing |
| 502 | `not_configured`, `provider_unreachable`, `invalid_did`, `no_balance`, `auth_failed`, `provider_error` | Provider refused; `message` is written for the agent |

### 3.2 `POST /api/hooks/{tenant}/{sourceId}` — lead-source webhook

For website forms, Google Ads lead forms, portals and partners. The request is stored and queued; processing (normalise → dedupe → assign) happens asynchronously.

```bash
curl -X POST "https://am2pmsupportproject.vercel.app/api/hooks/flo-mattress/7b1e…-uuid" \
  -H "x-source-key: <source key>" \
  -H "Content-Type: application/json" \
  -d '{"full_name":"Rahul S","phone_number":"9811111111","city":"Pune"}'
```

**200**
```json
{ "ok": true, "duplicate": false }
```
`duplicate: true` = the same body was already received; nothing new is queued.

Field mapping is per source (`import_sources.field_map`, e.g. `{"phone_number":"phone","city":"custom.city"}`); unmapped fields are kept in `custom`. Leads with neither a valid Indian mobile nor an email are dropped during processing.

| HTTP | Code | When |
| --- | --- | --- |
| 401 | `unauthorized` | Missing or wrong source key |
| 404 | `not_found` | Unknown tenant slug, source id, or source paused |

### 3.3 `POST|GET /api/hooks/{tenant}/telephony/{provider}/{key}` · `POST|GET /api/hooks/{tenant}/telephony/{provider}` — call webhooks

URL (shown once in Setup → Telephony → **New URL**): `{PUBLIC_URL}/api/hooks/{tenant}/telephony/callerdesk/<secret>` — secret in the **path** (2026-10-02: CallerDesk's POSTs with `?key=` arrived without a valid key). The older `?key=<secret>` form is still accepted. A rejected webhook logs why (key missing / length / method / field names) without logging the key. `PUBLIC_URL` is always the public HTTPS site, never localhost (a provider can't reach a laptop). The `?key=` is compared by hash; wrong key → 401.

CallerDesk setup (Settings → Webhook): tick **Call Report** and **Live Call**; method **POST** (JSON) recommended, GET (query string) also works — including when CallerDesk appends `?…` to our `?key=` URL.

Payload fields used (CallerDesk docs, api.callerdesk.io, checked 2026-10-02):

| Field | Meaning |
| --- | --- |
| `type` | `call_report` = end of call (else a Live Call event) |
| `Direction` | `IVR` incoming · `WEBOBD` outgoing (click-to-call) |
| `SourceNumber` / `DialWhomNumber` | outgoing: agent (leg A) / customer (leg B) · incoming: caller / agent who answered |
| `DestinationNumber` | the DID (virtual number) — maps an incoming call to its process |
| `campid` | outgoing call id = `campid` returned by click-to-call → matches our call |
| `CallSid`, `Uniqueid` | call id for incoming calls |
| `Status` | `ANSWER`, `BUSY`, `CANCEL`, `NOANSWER`, … |
| `LegA_Picked_time`, `LegB_Start_time`, `LegB_Picked_time` | outgoing result: agent never picked → agent_no_answer; customer didn't → no_answer / busy |
| `StartTime`, `EndTime` | `yyyy-mm-dd hh:mm:ss` in IST (read as +05:30) |
| `CallDuration`, `TalkDuration` | seconds |
| `CallRecordingUrl` | recording (https only) → copied later (T1.39) |
| `hangup_cause` | e.g. `ANSWER(16-customer)` → who hung up |

Returns `200 {ok:true}` after storing the event; processing runs in the `process-webhook` job. Setup → Telephony shows the last event received, events in 24 h and the last error.

Click-to-call (outbound request we send): `GET https://app.callerdesk.io/api/click_to_call_v2?authcode&calling_party_a=<agent 10 digits>&calling_party_b=<customer 10 digits>&deskphone=<DID with leading 0>&call_from_did=1` → `{"type":"success","campid":…}`.

### 3.4 `POST /api/jobs/{job}` — internal (QStash)

Not for external use. Jobs: `process-webhook`, `assign-lead`, `deliver-webhook`, `relay-outbox`, `sweep-unassigned`, `sweep-stuck-calls`, `purge-expired`, `recount-open-leads`, `copy-recording`, `callback-reminders`. Returns `200 {ok:true}`; `500` makes QStash retry; `401` on a bad signature.

### 3.5 `GET /api/cron/{job}` — internal (Vercel Cron)

Fans out the matching job to QStash. Allowed: `relay-outbox`, `sweep-unassigned`, `sweep-stuck-calls`, `purge-expired`, `recount-open-leads`. Schedules are in `vercel.json` (daily while the team is on the Hobby plan; see TASK.md T3.15).

Frequent jobs run on **QStash schedules** instead (created by `npm run setup:schedules`, ids `am2pm-*`), which call `/api/jobs/{job}` directly with a signature: `callback-reminders` every 5 min; `sweep-unassigned`, `relay-outbox`, `sweep-stuck-calls` every 15 min.

### 3.7 `GET /api/v1/leads` — list, filter and quick search

Session cookie or API key (`read`). Returns leads in the caller's scope (agent: own; supervisor/manager/coordinator: their processes; admin: whole workspace). Phones are masked for roles that may not see them. These are exactly the Leads screen's URL params (a saved filter stores them).

| Query | Meaning |
| --- | --- |
| `q` | Name / email (2+ letters), phone digits (3+), or a full number (exact, indexed) |
| `status` | `open` (default) · `won` · `lost` · `dnc` · `all` · `deleted` (Recycle bin — roles with leads **D** only) |
| `stage`, `source`, `process` | comma-separated values (source = kind, e.g. `meta_ads,web_form`; process = ids) |
| `owner` | comma-separated user ids; `none` = unassigned |
| `flag` | comma-separated system filters (all must match): `mine`, `unassigned`, `assigned`, `not_called`, `touched`, `callback_overdue`, `callback_today`, `has_callback`, `no_callback`, `re_enquired`, `stale_7d` (no activity 7+ days), `has_email`, `no_email`, `no_phone`, `converted_today` |
| `created` | `today` · `7d` · `30d` (workspace timezone) |
| `created_from`, `created_to` · `activity_from`, `activity_to` · `callback_from`, `callback_to` | `yyyy-mm-dd`, inclusive, workspace timezone (created date · last activity · next callback) |
| `campaign`, `outcome` | comma-separated campaign names / last-outcome labels |
| `city` | contains (case-insensitive) |
| `attempts_min`, `attempts_max` | call attempts range |
| `cf_<key>` | custom field filter, one param per field: `~text` contains · `=a\|b` any of · `n:5..20` number range · `d:2026-10-01..2026-10-31` date range · `b:yes` / `b:no`. Either side of a range may be empty. Unknown/malformed values are ignored. |
| `sort` | `newest` (default) · `oldest` · `name` · `callback` · `activity` |
| `limit` | 1–100, default 50 (UI: 25/50/100) |
| `cursor` | `nextCursor` from the previous page (keyset on sort value + id; never OFFSET) |
| `before` | `prevCursor` — the page before (keyset walked backwards, then flipped) |

`200 {items: LeadRow[], nextCursor: string | null, prevCursor: string | null, total: number}` · `400 invalid_query` · `401` · `403`.

### 3.8 `GET /api/v1/leads/export` — CSV

Session cookie or API key (`read`). Same query params (no `cursor`). Needs the leads **X** permission. Up to 10,000 rows, phones masked per role, formula-looking cells neutralised (CSV injection), audited as `leads.exported`.

### 3.9 `GET /api/v1/calls/{id}/recording` — play a call recording

Session cookie or API key (`read`) + `interactions` V, and the call must be in the viewer's scope (agents: their own calls; supervisors/managers/coordinators/clients: their processes; admins: workspace). Streams our private Blob copy (`recordings/<tenant>/<yyyy>/<mm>/<id>.<ext>`); until the copy exists, proxies CallerDesk's file (https on `*.callerdesk.io` only) with `Range` passthrough. The provider URL never reaches the browser. `cache-control: private, no-store`. Starting playback is audited (`recording.played`). `404` when there's no recording or the call isn't yours.

Calls log data (Calls screen) and "Sync now" are server-side (lib/calls/list.ts, lib/telephony/sync.ts). The `sync-calls` job (QStash, every 15 min) pulls CallerDesk's Call Report API (`POST https://app.callerdesk.io/api/call_list_v2`, form: `authcode`, `start_date`, `end_date`, `current_page`, `per_page`) and runs each row through the same parser as webhooks — calls whose webhooks were missed still get their result, durations and recording.

Screen-only operations (save outcome, change stage, start a call from the console, Setup CRUD, notifications, saved filters, bulk assign / stage, Create Lead, edit lead, delete to / restore from the Recycle bin, company settings, workspace switching) are Next.js **server actions** behind the same session + RBAC checks; they become public REST endpoints only when an external caller needs them (section 5).

### 3.10 `GET /api/v1/me` — who am I

`200 {userId, name, role, workspace: {id, slug, name, timezone}, via: "session"|"api_key", scope: "read"|"write"}`. Use it to check a key.

### 3.11 `POST /api/v1/leads` — create a lead

`write`. Same path as every source: normalise → dedupe → auto-assign (DESIGN.md §3). With an API key the lead's source is `api`; from a session, `manual`.

```json
{ "processId": "uuid", "name": "Asha Rao", "phone": "+91 98765 43210", "email": "asha@example.com",
  "city": "Pune", "note": "Asked for a callback", "campaign": "Partner-Oct", "ownerId": "uuid (optional; supervisors/admins)",
  "custom": { "budget": "5L", "site_visit": true } }
```

Needs a valid 10-digit mobile or an email. **201** `{"outcome":"created","leadId":"…"}` · **200** `{"outcome":"merged","leadId":"…"}` (an open lead with the same number/email already existed — no duplicate) · `400 invalid_input` · `403 read_only_key` / `forbidden` · `404` unknown process.

### 3.12 `GET /api/v1/leads/{id}` · `PATCH /api/v1/leads/{id}` · `DELETE /api/v1/leads/{id}` · `POST /api/v1/leads/{id}/restore`

- **GET** (`read`): full lead — contact (phone masked per role), status, stage, stages, process, source, campaign, attempts, owner, DNC, next callback, `custom`, `outcomes` (ids for §3.13), `timeline` (events + calls with `callId`, `hasRecording`). `404` if not in your scope.
- **PATCH** (`write`): partial update — any of `name`, `phone` (only roles that see full numbers), `email`, `campaign`, `stage`, `ownerId` (supervisors/admins), `custom` (merged; `""` removes a key). Returns the updated lead. `409` if the new number/email belongs to another open lead in the process.
- **DELETE** (`write`, leads **D**: admins): moves to the Recycle bin → `{deleted, skipped}`.
- **POST …/restore** (`write`, admins): `{restored, skipped}` (skipped when an open lead now holds the same number).

### 3.13 `POST /api/v1/leads/{id}/outcome` · `POST /api/v1/leads/{id}/stage` · `POST /api/v1/leads/assign`

- **outcome** (`write`): `{"dispositionId":"uuid","note":"…","callbackAt":"2026-10-04T10:30:00+05:30"}` (`callbackAt` required for callback outcomes). Runs the outcome rules (callback, convert, close, DNC) and emits events. Returns the lead.
- **stage** (`write`): `{"stage":"Hot"}`; the won stage converts. Returns the lead.
- **assign** (`write`, supervisors/admins): `{"leadIds":["uuid",…≤200],"ownerId":"uuid"}` → `{moved, skipped}` (skipped: not in scope, already theirs, or agent not on that process).

### 3.14 `GET /api/v1/calls` — call log

`read`. Query: `range` (`today`·`7d` default·`30d`·`all`), `direction` (`inbound`/`outbound`), `result` (`connected`·`not_connected`·`missed`), `agent` (user id), `recording=yes`, `q` (lead name or phone digits), `limit` (1–100), `cursor`. → `{items:[{id, startedAt, direction, status, durationSec, talkSec, hasRecording, leadId, leadName, customer, agentName, processName, outcome, hangupBy}], nextCursor, total}`. Agents get their own calls only. Play recordings with §3.9.

### 3.15 `GET /api/v1/processes` · `GET /api/v1/users`

- **processes** (`read`): `{items:[{id, name, status, stages, wonStage, outcomes:[{id, code, label, category}]}]}` — the ids you need for §3.11 and §3.13.
- **users** (`read`, `users` V): `{items:[{id, name, role, status, isAvailable, processIds}]}` — no phone numbers or emails over the API.

### 3.16 `POST /api/graphql` · `GET /api/graphql` — GraphQL

Same auth as REST. Schema, examples and limits: **§6**.

### 3.17 `POST /api/imports/upload` — CSV/Excel upload token (internal, browser)

Session + `import_sources` C. Issues a short-lived token so the browser uploads straight to the private Blob store (`imports/<tenantId>/…`, `.csv`/`.xlsx`, ≤ 20 MB); the import then starts via the Setup screen (T1.26).

### 3.6 `GET /api/health` — public

For uptime monitors. Never returns hostnames, errors or values. `replicas` lists read replicas and whether each is in rotation (empty when none are configured).

**200** (all up) / **503** (something down)
```json
{ "ok": true, "database": { "ok": true, "ms": 5 }, "redis": { "ok": true, "ms": 66 },
  "replicas": [ { "name": "replica-1", "healthy": true } ] }
```

## 4. Outbound webhooks (CRM → your system)

Admins register an HTTPS URL and choose events (admin UI and `CRUD /api/v1/webhook-subscriptions` are planned, T2.9; delivery is implemented).

### 4.1 Events

| Event | Fires when |
| --- | --- |
| `lead.created` | Any import or manual create |
| `lead.assigned` | Auto or manual assignment |
| `disposition.set` | Agent saves a call outcome |
| `lead.stage_changed` | Stage moves |
| `lead.converted` | Disposition category `converted`, or stage = process won stage |
| `lead.lost` | Negative or DNC disposition closes the lead |
| `callback.missed` | Callback due + 15 min with no call |
| `call.completed` | A connected call (inbound or outbound) ends |
| `call.missed` | An inbound call is not answered |
| `backup.completed` / `backup.failed` | Tenant backup finishes |
| `restore.completed` | A restore job finishes |

Event names are a public contract: new events may be added; existing ones are never renamed.

### 4.2 Request we send

```http
POST https://client.example.com/crm-hook
Content-Type: application/json
User-Agent: AM2PM-CRM-Webhooks/1
X-AM2PM-Signature: t=1790812345,v1=5f2c…e91

{
  "id": "evt_6701c2…",
  "type": "lead.converted",
  "tenant": "flo-mattress",
  "occurredAt": "2026-10-01T09:14:05.000Z",
  "data": { "leadId": "…", "processId": "…", "…": "…" }
}
```

### 4.3 Verify the signature (receiver side)

`v1 = hex(HMAC-SHA256(secret, t + "." + rawBody))`. Reject if `|now − t| > 300` seconds.

```js
import crypto from "node:crypto";

export function verify(secret, rawBody, header) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return expected.length === parts.v1?.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

### 4.4 Delivery

- Any 2xx = delivered. Respond within 10 seconds; do heavy work after responding.
- Retries at roughly 1 min, 5 min, 30 min, 2 h, 12 h. Every attempt is logged.
- After 24 hours of continuous failure the subscription is paused and admins are emailed (email: T2.10).
- At-least-once: dedupe on `id`. Events can arrive out of order; use `occurredAt`.
- We do not follow redirects.

## 5. Planned endpoints (not yet live)

| Method + path | Purpose | Task |
| --- | --- | --- |
| `POST /api/v1/imports` | Upload CSV, returns batch id | T1.26 |
| `CRUD /api/v1/webhook-subscriptions` | Manage outbound webhooks; test-send | T2.9 |
| `GET/POST /api/v1/backups`, `POST /api/v1/backups/{id}/download` | Snapshots, backup now, download (fresh TOTP) | T3.7 |
| `POST /api/v1/restores`, `POST /api/v1/restores/{id}/approve` | Request / approve restore (two-person rule) | T3.8 |
| `GET /api/v1/stream` | Server-Sent Events: new leads, screen-pop, call status | T1.40 |
| `GET /api/v1/search?q=` | Quick search by name, phone digits or email → contacts + their active leads (logic ready: `searchContacts()`, DESIGN.md §2.5) | T1.47 |
| `POST /api/hooks/{tenant}/telephony/{provider}/route` | Optional inbound routing lookup | T2.6a |

When an endpoint ships: move it to §3 with its real request/response and error codes, in the same change.

## 6. GraphQL API

`POST /api/graphql` (`GET` for simple queries) — the same data and actions as REST v1 in one schema. Ask for exactly the fields you need, and combine several reads in **one round trip** (e.g. `me` + a page of leads + one lead's timeline). Every resolver calls the same functions as REST and the screens, so scope, RLS, dedupe, events and audit are identical.

- **Auth**: session cookie or `Authorization: Bearer am2pm_…` (§2). Mutations need a `write` key. Unauthenticated → `errors[0].extensions.code = "unauthorized"`.
- **Errors**: `errors[].extensions.code` uses the REST codes (`invalid_input`, `read_only_key`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `invalid_api_key`, `internal`).
- **Limits**: max selection depth 6 (introspection exempt); no batching; 600 requests/min per API key (shared with REST).
- **Speed**: `lead(id)` is a single SQL statement; `leads { total }` is only counted when you select `total`; `processes { outcomes }` only loads outcomes when selected.
- **Paging**: keyset — `leads(after: endCursor)` for next, `leads(before: startCursor)` for previous; `calls(after: endCursor)`.
- **Introspection / GraphiQL**: allowed for authenticated callers (open `/api/graphql` in a signed-in browser).

### 6.1 Examples

```graphql
# One round trip: who am I + today's overdue callbacks + one lead with its timeline
query Dashboard($id: ID!) {
  me { name role workspace { name timezone } }
  leads(filter: { flag: ["callback_overdue"] }, sort: callback, first: 20) {
    items { id name phone stage owner nextCallbackAt }
    endCursor hasNextPage total
  }
  lead(id: $id) { name stage custom timeline { title at by callId hasRecording } }
}
```

```graphql
mutation {
  createLead(input: { processId: "…", name: "Asha Rao", phone: "9876543210", campaign: "Partner-Oct", custom: { budget: "5L" } }) { outcome leadId }
}
```

```bash
curl https://am2pmsupportproject.vercel.app/api/graphql \
  -H "Authorization: Bearer am2pm_…" -H "Content-Type: application/json" \
  -d '{"query":"{ me { name workspace { name } } }"}'
```

### 6.2 Schema (source of truth: `lib/graphql/schema.ts` — kept identical by `tests/api-docs.test.ts`)

```graphql
"Any JSON value (custom lead fields)."
scalar JSON

type Query {
  "Who this request acts as."
  me: Me!
  "Leads in your scope. Keyset paging: pass endCursor as after (next) or startCursor as before (previous)."
  leads(filter: LeadFilter, sort: LeadSort = newest, first: Int = 50, after: String, before: String): LeadConnection!
  "One lead with contact, custom fields, outcomes and timeline."
  lead(id: ID!): LeadDetail
  "Call log in your scope (agents: own calls)."
  calls(filter: CallFilter, first: Int = 50, after: String): CallConnection!
  "Processes with stages and active outcomes."
  processes: [Process!]!
  "Team members (no phone numbers or emails)."
  users: [User!]!
}

type Mutation {
  "Create a lead; merges into the open lead with the same number/email."
  createLead(input: CreateLeadInput!): CreateLeadResult!
  "Partial update: omitted fields stay as they are."
  updateLead(id: ID!, input: UpdateLeadInput!): LeadDetail!
  "Move leads to the Recycle bin (admins)."
  deleteLeads(ids: [ID!]!): BulkResult!
  "Restore leads from the Recycle bin (admins)."
  restoreLeads(ids: [ID!]!): BulkResult!
  "Move a lead to a stage; the won stage converts it."
  setStage(id: ID!, stage: String!): LeadDetail!
  "Save a call outcome; callbackAt (ISO time) is required for callback outcomes."
  saveOutcome(id: ID!, outcomeId: ID!, note: String, callbackAt: String): LeadDetail!
  "Reassign up to 200 leads to one agent (supervisors and admins)."
  assignLeads(ids: [ID!]!, ownerId: ID!): BulkResult!
}

type Me {
  userId: ID!
  name: String!
  role: String!
  workspace: Workspace!
  via: String!
  scope: String!
}

type Workspace {
  id: ID!
  slug: String!
  name: String!
  timezone: String!
}

enum LeadSort {
  newest
  oldest
  name
  callback
  activity
}

input LeadFilter {
  q: String
  status: String
  stage: [String!]
  source: [String!]
  owner: [String!]
  process: [ID!]
  "System filters, e.g. mine, unassigned, not_called, callback_overdue, has_email, stale_7d (API.md §3.7)."
  flag: [String!]
  created: String
  campaign: [String!]
  outcome: [String!]
  city: String
  attemptsMin: Int
  attemptsMax: Int
  "Dates are yyyy-mm-dd in the workspace timezone, inclusive."
  createdFrom: String
  createdTo: String
  activityFrom: String
  activityTo: String
  callbackFrom: String
  callbackTo: String
  "Custom fields { key: encoded value }: ~text contains, =a|b any of, n:min..max, d:from..to, b:yes or b:no (API.md §3.7)."
  custom: JSON
}

type LeadConnection {
  items: [Lead!]!
  endCursor: String
  startCursor: String
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  "Matching leads (only computed when requested)."
  total: Int!
}

type Lead {
  id: ID!
  name: String!
  phone: String!
  email: String
  processId: ID!
  processName: String!
  source: String!
  campaign: String
  stage: String!
  status: String!
  ownerId: ID
  owner: String
  lastOutcome: String
  attempts: Int!
  nextCallbackAt: String
  lastActivityAt: String
  createdAt: String!
  city: String
}

type LeadDetail {
  id: ID!
  name: String!
  phone: String!
  email: String
  status: String!
  stage: String!
  stages: [String!]!
  processId: ID!
  processName: String!
  source: String!
  campaign: String
  attempts: Int!
  owner: String
  ownerId: ID
  dnc: Boolean!
  nextCallbackAt: String
  lastOutcome: String
  createdAt: String!
  custom: JSON!
  outcomes: [Outcome!]!
  timeline: [TimelineEntry!]!
}

type Outcome {
  id: ID!
  label: String!
  category: String!
  code: String
}

type TimelineEntry {
  id: ID!
  kind: String!
  title: String!
  detail: String
  at: String!
  by: String
  callId: ID
  hasRecording: Boolean
}

input CallFilter {
  q: String
  direction: String
  result: String
  agent: ID
  recording: Boolean
  range: String
}

type CallConnection {
  items: [Call!]!
  endCursor: String
  hasNextPage: Boolean!
  total: Int!
}

type Call {
  id: ID!
  startedAt: String!
  direction: String!
  status: String!
  durationSec: Int
  talkSec: Int
  hasRecording: Boolean!
  "Play with the same auth: GET this path."
  recordingPath: String
  leadId: ID
  leadName: String
  customer: String!
  agentName: String
  processName: String
  outcome: String
}

type Process {
  id: ID!
  name: String!
  status: String!
  stages: [String!]!
  wonStage: String!
  outcomes: [Outcome!]!
}

type User {
  id: ID!
  name: String!
  role: String!
  status: String!
  isAvailable: Boolean!
  processIds: [ID!]!
}

input CreateLeadInput {
  processId: ID!
  name: String!
  phone: String
  email: String
  city: String
  note: String
  campaign: String
  ownerId: ID
  custom: JSON
}

type CreateLeadResult {
  outcome: String!
  leadId: ID!
}

input UpdateLeadInput {
  name: String
  phone: String
  email: String
  campaign: String
  stage: String
  ownerId: ID
  custom: JSON
}

type BulkResult {
  done: Int!
  skipped: Int!
}
```

### 6.3 REST or GraphQL?

| Use | Pick |
| --- | --- |
| Simple integration: push a lead, read one record, export | REST (§3) — plain JSON, easy with any tool |
| Screens/apps needing several things at once, or only a few fields of each | GraphQL — one request, smaller responses |
| Webhooks from providers, file downloads (CSV, recordings) | REST only |
