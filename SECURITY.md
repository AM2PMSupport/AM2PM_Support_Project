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
| Unauthenticated access to screens and APIs | Email + password sign-in → signed HttpOnly session cookie (HMAC-SHA256 with `AUTH_SECRET`, 12 h, `Secure`, `SameSite=Lax`); `(app)` layout redirects to `/login`; `requireSession()` on APIs | **Enforced** |
| Password theft from the database | scrypt (N=16384, r=8, p=1, 16-byte salt) per password; only hashes stored; constant-time compare | **Enforced** |
| Password guessing / account enumeration | 5 failures per email and 300 per IP per 15 min (Redis; high per-IP ceiling because a whole office shares one IP) → 429; same error for unknown email and wrong password; dummy hash on unknown emails | **Enforced** |
| Credential stuffing beyond the login throttle | Optional TOTP 2FA, IP allowlist for agents, Google sign-in | **Planned** (T3.10, T3.12) |
| SQL injection | Every query goes through Drizzle with values as bound parameters; `sql.raw` / `sql.unsafe` banned by ESLint (`no-restricted-syntax`, 2026-10-05); LIKE input escaped (`escapeLike`); sort fields and filter keys are allowlists / regex-checked and passed as parameters; Zod on every input. Tests: hostile search, filter and custom-field values return nothing and leave the table intact (`tests/integration/leads-list.test.ts`) | **Enforced** |
| Attendance data across workspaces | Jibble data lives in platform tables the app role can't read (REVOKE, verified by test); each screen first loads its own members through RLS and asks only for their accounts; connecting Jibble is Super Admin only (fixed rule); Client Secret AES-256-GCM, never returned, token kept in memory only; GPS / screenshots not imported | **Enforced** (2026-10-06) |
| Report data leaving the app | Reports CSV needs Reports · X, same scope as the screen (agents: own numbers), cells neutralised against spreadsheet formulas, every export audited (`report.exported`) | **Enforced** (2026-10-05) |
| Abuse of the app by a signed-in person or script | One per-person bucket, 300 requests/min, shared by every server action (Console, Leads, Setup, Calls, notifications, workspace switch) and session calls to `/api/v1` / GraphQL → 429 (`lib/http/rate-limit.ts`); "Sync now" max 2/min per workspace; API keys 600/min per key and 1,200/min per workspace | **Enforced** (2026-10-05) |
| Guessing webhook keys / probing workspace slugs | Wrong key, unknown workspace or unknown source counts against the caller's IP; 30 in 15 min → 429 before any database work, on both lead-source and telephony webhooks | **Enforced** (2026-10-05) |
| Webhook floods | Vercel Firewall rate limits on `/api/hooks/*` (e.g. 300/min per source) | **Planned** (T3.12) |
| Recording links shared publicly | Short-lived signed URLs; every play audit-logged | **Planned** (T1.39) |
| Insider misuse | Append-only `audit_logs` (app role cannot UPDATE/DELETE); two-person rule for restores; fresh TOTP for backup download | **Partly** — table + grants enforced; writers and backup UI planned |
| Database server or availability-zone failure | Neon multi-AZ storage replication + automatic compute recovery; read-replica circuit breaker with primary fallback (ARCHITECTURE.md §10) | **Enforced** (managed + code) |
| Data loss / bad bulk change | Neon point-in-time restore + per-tenant encrypted backups to a separate R2 bucket | **Planned** (T1.43, T3.13) |

## 3. Tenant isolation in detail

1. Every tenant table has `tenant_id`, defaulting to `current_setting('app.tenant_id')`.
2. `withTenant(ctx, fn)` opens a transaction, runs `select set_config('app.tenant_id', <uuid>, true), set_config('role', 'app_rls', true)` — the second is exactly `SET LOCAL ROLE app_rls` (transaction-local; the connection returns to the owner role at commit, verified on Neon 2026-10-02).
3. `app_rls` is `NOLOGIN NOBYPASSRLS` and owns nothing. Policy on every tenant table: `USING` and `WITH CHECK` `tenant_id = current_setting('app.tenant_id', true)::uuid`.
4. Both settings are transaction-scoped, so they are safe with Neon's PgBouncer pooling and cannot leak to the next request.
5. Only `lib/platform-admin` uses the owner connection (cross-tenant sweeps, tenant lookup by slug, health check).

### 3.1 Logins and workspace switching (2026-10-02)

One person = one **login** (`accounts`: email + one scrypt password) with a **membership** (`users` row, role per workspace) in each workspace they work in — the Zoho-style "jump to organisation". The session cookie names the login (`aid`) and ONE membership (`uid`, `tid`); switching re-issues it for another membership. Rules:

1. `accounts` is platform-level: `REVOKE ALL … FROM app_rls` plus RLS with no policy (0007). Only `lib/platform-admin/auth.ts` reads or writes it; never call it from inside a `withTenant` transaction.
2. A workspace admin can create logins only for emails with **no membership in another workspace**; linking an existing login into a further workspace is a **super-admin** action. (Otherwise an admin of client A could create "AM2PM staff" in A, know the password, and walk into client B.)
3. A workspace admin can **reset the password or change the email** of a login only if it belongs to their workspace alone. Multi-workspace logins: super admin only.
4. Switching re-checks the membership live (active user, active workspace); the target tenant id comes from the server-side membership list, never from the client. Super admins may enter any active workspace; that creates a `super_admin` membership there and writes `workspace.entered_by_super_admin` to that workspace's audit log. Every switch writes `workspace.switched_in`.
5. Migration 0007 linked only emails that existed in exactly one workspace; duplicates (none at the time) stay unlinked until a super admin links them.

Verified: `tests/integration/admin.test.ts` (cross-workspace rules, app role denied on `accounts`), live on Neon 2026-10-02 (`permission denied for table accounts`; 8/8 logins migrated with their passwords).

Verified: `tests/integration/postgres.test.ts` (PGlite) and a live check on Neon on 2026-10-01 — tenant B saw 0 of tenant A's rows; writing a row for another tenant is rejected; `audit_logs` delete is refused.

### 3.2 API keys (REST + GraphQL, 2026-10-03)

- `Authorization: Bearer am2pm_<random>`; only the SHA-256 is stored (`api_keys`, RLS), the key is shown once. Lookup by hash uses the platform connection (tenant unknown until then) and requires: not revoked, creating user active, workspace active/trial.
- A key acts as the user who created it: same role, scope, RLS and audit trail (actor name gets " (API)"). Scope `read` blocks every write (`403 read_only_key`); RBAC still applies to `write` keys.
- 600 requests/min per key (Redis fixed window) → `429`. `last_used_at` updated at most every 5 min. Create/revoke audited.
- GraphQL: authentication required for every operation including introspection; depth limit 6 (introspection exempt); batching off; unexpected errors masked as `internal` (logged server-side).
- No phone numbers/emails in `/api/v1/users`; lead phones masked per role exactly as on screen.

### 3.3 Editable role permissions (2026-10-05)

- A Super Admin can change any role's permissions for their own workspace (Setup → Roles, DESIGN.md §7). "Super Admin only" is checked in code (`lib/admin/roles.ts`), not read from the matrix, so an edited matrix can never grant someone the editor.
- Super Admin's own column is locked (no lock-out); edits for it, for unknown areas or with letters outside `VCEDAXI` are rejected on save and ignored on load.
- Edits live in `role_permissions` under RLS, so one workspace's matrix can't be read or written from another. A Save is one transaction (all cells or none); every changed cell writes `role_permission.changed` (before → after) to the audit log.
- Every check uses the actor's grants for the current workspace, loaded per request for sessions and API keys alike; a removed permission takes effect on the editor's instance at once and on others within 30 s.
- Data scope (own / process / tenant) and phone masking stay fixed per role; the matrix can't widen them.
- Module access switches (`screen.<name>`): a module needs its switch on AND the permissions to use it. Switching one on also grants View on the area it needs (one audited save, Super Admin only), never more. Hiding a module also blocks its URL; the APIs behind it stay governed by the matrix.
- **No probing by URL** (2026-10-05): a module page or Setup tab the person may not open returns **404**, the same page and status as a URL that doesn't exist (`requirePage` → `notFound()`, Setup `?tab=` checked against `tabVisible`). Record links work the same way: a lead (`/console?lead=…`, `/leads/{id}`) or process (`/admin?tab=outcomes&process=…`) from another workspace or outside the person's scope is a 404, never a silent jump to some other record. A URL never reveals whether a module or record exists or is hidden. Not signed in still goes to /login. Verified: `tests/integration/leads-list.test.ts` (another workspace's / another agent's lead).
- Client, trainer, HR and accounts have process scope: if granted lead/call rights they see only the processes they're mapped to, never the whole workspace.

Verified: `tests/integration/roles.test.ts` (Super Admin only, locked column, audit, workspace isolation), `tests/rbac.test.ts` (edits reach checks, bad edits ignored, module access hides and can't widen).

## 4. Secrets management

| Secret | Where it lives | Rotation |
| --- | --- | --- |
| `DATABASE_URL`, `QSTASH_*`, `UPSTASH_REDIS_*` | Vercel env (injected by Marketplace integrations); `.env.local` for dev | Rotate in the provider dashboard → `vercel env pull` / redeploy |
| `MASTER_ENCRYPTION_KEY` | Vercel env (sensitive), different per environment | Rotation needs re-encrypting `credentials_enc` / `secret_enc` columns — write a migration script first; never just replace it |
| `CRON_SECRET`, `AUTH_SECRET` | Vercel env (sensitive) | Replace and redeploy |
| Seeded role accounts (`npm run seed:users`) | Passwords only in local `PASSWORD.md` (git-ignored, mode 600); database holds scrypt hashes | `npm run seed:users -- --reset` rotates all and rewrites the file |
| Lead-source keys, webhook subscription secrets | Shown once to the admin; stored hashed (source keys) or encrypted (webhook secrets) | Regenerate from the admin UI (planned) |

Rules:
- Never commit `.env.local`, `PASSWORD.md` or any real value. `.env.example` holds names only.
- The seeded role accounts are shared demo logins: before real clients go live, give each person their own account and rotate or delete these.
- Production secrets are generated separately from development ones and marked **sensitive** in Vercel (write-only).
- Never paste secrets into issues, PRs, chat logs or docs.


**One `MASTER_ENCRYPTION_KEY` per database.** Local development and production use the same Neon database, so they MUST use the same key: anything saved from localhost (e.g. CallerDesk auth code, webhook secret) has to be readable in production. On 2026-10-02 production had a different key, so a CallerDesk connection made from localhost could not be decrypted in production (500 on every webhook). Production and Development now share the key (set straight from `.env.local`, never printed). An unreadable secret now logs "MASTER_ENCRYPTION_KEY mismatch" and returns 503 instead of crashing. Rotating the key needs a re-encrypt script (not built yet).

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
