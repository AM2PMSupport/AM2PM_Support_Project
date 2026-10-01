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
| 401 | `auth_not_configured` | People-facing APIs are closed until sign-in ships (T1.11) |
| 403 | `forbidden`, `dnc` | Not allowed / contact is on Do Not Call |
| 404 | `not_found` | Unknown tenant, source, lead or route |
| 409 | `conflict`, `already_on_call` | State conflict |
| 422 | `no_phone`, `no_agent_phone`, `no_telephony`, `no_did` | Setup missing for this action |
| 500 | `internal` | Unexpected error (details only in server logs) |
| 502 | provider codes (see §3.1) | The telephony provider rejected the request |

## 2. Authentication

| Caller | Mechanism | Used by |
| --- | --- | --- |
| People (agents, managers, admins, clients) | Session cookie from Auth.js (Google / email OTP, optional TOTP) — **planned T1.11**; until then these routes return `401 auth_not_configured` | `/api/v1/*` |
| Lead sources | Source key in header `x-source-key` (or `?key=`), shown once when the source is created | `/api/hooks/{tenant}/{sourceId}` |
| Telephony provider | Per-tenant webhook secret as `?key=` in the webhook URL (CallerDesk sends no signature) | `/api/hooks/{tenant}/telephony/{provider}` |
| QStash (internal) | `Upstash-Signature` header, verified with current + next signing keys | `/api/jobs/*` |
| Vercel Cron (internal) | `Authorization: Bearer $CRON_SECRET` | `/api/cron/*` |
| Partners / client CRMs | Tenant API key — **planned T2.5** | `POST /api/v1/leads` |

## 3. Implemented endpoints

### 3.1 `POST /api/v1/leads/{id}/call` — click-to-call

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

### 3.3 `POST|GET /api/hooks/{tenant}/telephony/{provider}` — call webhooks

Configured in the provider's panel (CallerDesk today). Receives inbound **and** outbound call events. Accepts JSON, form-encoded or query-string payloads; `GET` is accepted because some providers send events that way.

URL to paste into the provider: `https://am2pmsupportproject.vercel.app/api/hooks/{tenant}/telephony/callerdesk?key=<webhook secret>`

**200** `{ "ok": true, "duplicate": false }` · **401** bad key · **404** unknown tenant/provider or integration inactive.

Processing (async): match the call by correlation id → provider call id → agent + customer; inbound calls are routed by DID to a process; statuses only move forward; missed inbound calls create one callback per lead per day.

### 3.4 `POST /api/jobs/{job}` — internal (QStash)

Not for external use. Jobs: `process-webhook`, `assign-lead`, `deliver-webhook`, `relay-outbox`, `sweep-unassigned`, `sweep-stuck-calls`, `purge-expired`, `recount-open-leads`, `copy-recording`. Returns `200 {ok:true}`; `500` makes QStash retry; `401` on a bad signature.

### 3.5 `GET /api/cron/{job}` — internal (Vercel Cron)

Fans out the matching job to QStash. Allowed: `relay-outbox`, `sweep-unassigned`, `sweep-stuck-calls`, `purge-expired`, `recount-open-leads`. Schedules are in `vercel.json` (daily while the team is on the Hobby plan; see TASK.md T3.15).

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
| `POST /api/v1/leads` | Create a lead (partners / client CRMs), returns id + assignee | T2.5 |
| `GET /api/v1/leads?stage=&assignedTo=&cursor=` | List leads | T1.33 |
| `PATCH /api/v1/leads/{id}` | Update stage, custom fields | T1.34 |
| `POST /api/v1/leads/{id}/disposition` | Save call outcome (+ callback) | T1.35 |
| `GET /api/v1/calls/active` | Agent's live call after a page reload | T1.37d |
| `POST /api/v1/users/{id}/verify-phone` | Test click-to-call to an agent's own phone | T1.37b |
| `POST /api/v1/imports` | Upload CSV, returns batch id | T1.26 |
| `CRUD /api/v1/webhook-subscriptions` | Manage outbound webhooks; test-send | T2.9 |
| `GET/POST /api/v1/backups`, `POST /api/v1/backups/{id}/download` | Snapshots, backup now, download (fresh TOTP) | T3.7 |
| `POST /api/v1/restores`, `POST /api/v1/restores/{id}/approve` | Request / approve restore (two-person rule) | T3.8 |
| `GET /api/v1/stream` | Server-Sent Events: new leads, screen-pop, call status | T1.40 |
| `GET /api/v1/search?q=` | Quick search by name, phone digits or email → contacts + their active leads (logic ready: `searchContacts()`, DESIGN.md §2.5) | T1.47 |
| `POST /api/hooks/{tenant}/telephony/{provider}/route` | Optional inbound routing lookup | T2.6a |

When an endpoint ships: move it to §3 with its real request/response and error codes, in the same change.
