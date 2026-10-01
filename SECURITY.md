# SECURITY

How the AM2PM CRM protects client data, what is already enforced in code, and what is still planned. Hard rules for contributors are in [RULE.md](RULE.md); this file explains the security model behind them.

> **Reporting a vulnerability:** email **support@am2pmsupport.com** with "SECURITY" in the subject. Do not open a public GitHub issue — this repository is public. We aim to acknowledge within 2 working days.

## 1. What we protect

| Asset | Why it matters |
| --- | --- |
| Client lead and contact data (names, phones, emails, custom fields) | Personal data under India's DPDP Act; belongs to our clients |
| Call recordings and call metadata | Sensitive; contractual retention per client |
| Provider credentials (CallerDesk, Interakt, Brevo, Resend) | Can place calls / send messages billed to the client |
| Outbound webhook secrets | Let client systems trust our events |
| Platform secrets (`MASTER_ENCRYPTION_KEY`, `CRON_SECRET`, DB/queue tokens) | Full compromise if leaked |

## 2. Threats and controls

| Threat | Control | Status |
| --- | --- | --- |
| One client reads or changes another client's data | Postgres row-level security: every tenant transaction runs as `app_rls` with `app.tenant_id` set (`lib/db/tenant.ts`, `drizzle/0001_rls.sql`); lint bans the raw pool outside `lib/db` and `lib/platform-admin`; integration tests prove isolation | **Enforced** |
| Tenant id spoofed from a request body | `tenantId` only from a verified session, the slug in a verified webhook URL, or a QStash payload we published | **Enforced** (session part waits on sign-in, T1.11) |
| Forged provider / lead-source webhook | Per-source secret key (SHA-256 stored, constant-time compare); per-tenant telephony webhook secret, encrypted at rest | **Enforced** |
| Someone triggers background jobs | `/api/jobs/*` verifies the QStash signature (current + next signing key) | **Enforced** |
| Someone triggers cron jobs | `/api/cron/*` requires `Authorization: Bearer $CRON_SECRET` (constant-time compare) | **Enforced** |
| Webhook replay / duplicates | Idempotency key per event (provider id or body hash), unique index on `webhook_events` | **Enforced** |
| Our outbound webhooks forged or replayed | HMAC-SHA256 signature with timestamp, 5-minute window, stable event id (`lib/events/signature.ts`) | **Enforced** |
| Outbound webhook redirected to an internal host | `redirect: "manual"`, HTTPS-only URLs, 10 s timeout | **Partly** — HTTPS + private-IP blocking at subscription creation is T2.9 |
| Provider credentials leaked from the database | AES-256-GCM (`lib/crypto`), key only in Vercel env; never returned by any API | **Enforced** for storage; admin UI pending |
| Secrets in git | `.gitignore` excludes `.env*` (except `.env.example`), `.vercel`; secret scan before every push | **Enforced** |
| PII in logs | `lib/log.ts` redacts sensitive keys and masks phone-like numbers to the last 4 digits | **Enforced** |
| Agent places calls for leads that are not theirs / to DNC contacts | Click-to-call checks lead ownership (agent role), contact DNC, and one live call per agent | **Enforced** (full scope resolver is T1.14) |
| Unauthenticated access to people-facing APIs | `requireSession()` refuses every request until Auth.js is wired | **Enforced (fail-closed)**; sign-in is T1.11 |
| Credential stuffing / brute force | Google sign-in + email OTP, optional TOTP 2FA, IP allowlist for agents, rate limits on login | **Planned** (T1.11, T3.10, T3.12) |
| Webhook floods | Vercel Firewall rate limits on `/api/hooks/*` (e.g. 300/min per source) | **Planned** (T3.12) |
| Recording links shared publicly | Short-lived signed URLs; every play audit-logged | **Planned** (T1.39) |
| Insider misuse | Append-only `audit_logs` (app role cannot UPDATE/DELETE); two-person rule for restores; fresh TOTP for backup download | **Partly** — table + grants enforced; writers and backup UI planned |
| Database server or availability-zone failure | Neon multi-AZ storage replication + automatic compute recovery; read-replica circuit breaker with primary fallback (ARCHITECTURE.md §10) | **Enforced** (managed + code) |
| Data loss / bad bulk change | Neon point-in-time restore + per-tenant encrypted backups to a separate R2 bucket | **Planned** (T1.43, T3.13) |

## 3. Tenant isolation in detail

1. Every tenant table has `tenant_id`, defaulting to `current_setting('app.tenant_id')`.
2. `withTenant(ctx, fn)` opens a transaction, calls `set_config('app.tenant_id', <uuid>, true)` and `SET LOCAL ROLE app_rls`.
3. `app_rls` is `NOLOGIN NOBYPASSRLS` and owns nothing. Policy on every tenant table: `USING` and `WITH CHECK` `tenant_id = current_setting('app.tenant_id', true)::uuid`.
4. Both settings are transaction-scoped, so they are safe with Neon's PgBouncer pooling and cannot leak to the next request.
5. Only `lib/platform-admin` uses the owner connection (cross-tenant sweeps, tenant lookup by slug, health check).

Verified: `tests/integration/postgres.test.ts` (PGlite) and a live check on Neon on 2026-10-01 — tenant B saw 0 of tenant A's rows; writing a row for another tenant is rejected; `audit_logs` delete is refused.

## 4. Secrets management

| Secret | Where it lives | Rotation |
| --- | --- | --- |
| `DATABASE_URL`, `QSTASH_*`, `UPSTASH_REDIS_*` | Vercel env (injected by Marketplace integrations); `.env.local` for dev | Rotate in the provider dashboard → `vercel env pull` / redeploy |
| `MASTER_ENCRYPTION_KEY` | Vercel env (sensitive), different per environment | Rotation needs re-encrypting `credentials_enc` / `secret_enc` columns — write a migration script first; never just replace it |
| `CRON_SECRET`, `AUTH_SECRET` | Vercel env (sensitive) | Replace and redeploy |
| Lead-source keys, webhook subscription secrets | Shown once to the admin; stored hashed (source keys) or encrypted (webhook secrets) | Regenerate from the admin UI (planned) |

Rules:
- Never commit `.env.local` or any real value. `.env.example` holds names only.
- Production secrets are generated separately from development ones and marked **sensitive** in Vercel (write-only).
- Never paste secrets into issues, PRs, chat logs or docs.

## 5. Privacy and compliance (DPDP Act, India)

- **Consent:** `contacts.consent` per channel; bulk WhatsApp/email sends skip contacts without consent (enforcement in senders: T2.14–T2.17).
- **DNC:** `contacts.dnc` blocks calls (enforced in click-to-call) and all messaging.
- **Masking:** phone numbers masked by role in UI, API and exports (T1.15).
- **Retention:** raw webhooks 60 days, delivery logs 90 days, outbox 30 days after publish (`purge-expired` job — **enforced**); recordings and interactions per contract (planned).
- **Erasure:** a job that anonymises a contact and its interactions (planned, T3.11); per-tenant backup keys allow crypto-erasure of backups.
- **Data location:** Neon Postgres in Singapore (`sin1`) — the Vercel integration has no Mumbai region; QStash in Frankfurt; dedicated Redis planned in Mumbai. Recorded in [MEMORIE.md](MEMORIE.md).
- **Agreements:** data-processing agreement per client.

## 6. Dependencies and infrastructure

- Run `npm audit` before releases; update `next`, `pg`, `drizzle-orm`, `@upstash/*` promptly for security releases.
- Database, queue and cache are managed services (Neon, Upstash) billed and provisioned through the Vercel Marketplace; TLS is required on every connection.
- `GET /api/health` exposes only up/down booleans and latencies — never hostnames, errors or values.

## 7. Before every release (checklist)

- [ ] `npm run lint && npm run typecheck && npm test && npm run build` all pass.
- [ ] New tenant tables have `tenantId()` and an RLS policy migration; integration test added.
- [ ] New routes: input validated, auth checked, cross-tenant test added, errors use the standard shape.
- [ ] No secrets or real PII in the diff, tests or fixtures.
- [ ] New outbound calls (fetch) have timeouts and run outside DB transactions.
- [ ] Docs updated: [API.md](API.md) for routes, this file for new controls.
