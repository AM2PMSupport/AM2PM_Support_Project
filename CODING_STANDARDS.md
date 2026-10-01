# CODING STANDARDS

How code is written in this repository. [RULE.md](RULE.md) lists the non-negotiable rules (security, tenancy, data); this file covers style and structure so the codebase stays consistent as it grows. When in doubt, copy the pattern of the nearest existing file.

## 1. Language and tooling

| Tool | Setting |
| --- | --- |
| TypeScript | `strict`, `noUncheckedIndexedAccess`; no `any` in domain code (use `unknown` + narrowing) |
| Runtime | Node 20+, Next.js App Router, ESM (`"type": "module"`) |
| Imports | Absolute via `@/…` (e.g. `@/lib/db/tenant`); no deep relative `../../..` |
| Validation | Zod at every external boundary (env, request bodies, provider payloads where shaped) |
| Lint | `npm run lint` (eslint-config-next + project rules); zero errors and warnings |
| Tests | Vitest: `tests/*.test.ts` (unit), `tests/integration/*.test.ts` (Postgres via PGlite) |

Before pushing: `npm run lint && npm run typecheck && npm test && npm run build`.

## 2. Project structure

```
app/            routes only — thin handlers
lib/<domain>/   business logic, one folder per concern (leads, assignment, telephony, events…)
lib/db/         schema, pool, withTenant — the only database entry points
lib/platform-admin/  cross-tenant code only
lib/providers/<kind>/<name>/  one adapter per external provider
scripts/        one-off and ops scripts
tests/          mirrors lib/ by concern
drizzle/        generated + hand-written SQL migrations
```

- **Routes are thin:** parse/validate → auth → call one `lib/` function → return. No SQL or business rules in `app/`.
- **Pure logic in its own file** with no I/O (e.g. `assignment/methods.ts`, `telephony/state-machine.ts`, `leads/normalise.ts`, `events/signature.ts`) so it can be unit-tested directly.
- **One concern per file.** If a file needs a section divider, it may want splitting.
- **Extending** (new provider, job, event, table, assignment method): follow the "How to extend" table in [README.md](README.md).

## 3. Naming

| Thing | Convention | Example |
| --- | --- | --- |
| Files and folders | kebab-case | `click-to-call.ts`, `platform-admin/` |
| Types / interfaces | PascalCase | `TenantContext`, `NormalisedCallEvent` |
| Functions, variables | camelCase, verbs for functions | `createOrMergeLead`, `assignLead` |
| Constants | UPPER_SNAKE for module-level config | `MAX_TRIES`, `SIGNATURE_HEADER` |
| SQL tables / columns | snake_case (plural tables) | `lead_events.created_at` |
| Drizzle fields | camelCase mapped to snake_case | `createdAt: timestamp("created_at")` |
| Job names, event types | kebab-case jobs, dotted events | `assign-lead`, `lead.converted` |
| Env vars | UPPER_SNAKE, grouped per service | `QSTASH_TOKEN` |

Use the domain words from [MEMORIE.md §7](MEMORIE.md#7-glossary): tenant, process, disposition, DID, click-to-call.

## 4. Comments

- **Every file starts with a header comment:** what it does, why it exists, and the DESIGN/RULE section it implements.
- Comment the **why** — rules, races, provider quirks, security reasons — not what the code obviously does.
- Unfinished work: `// TODO(T1.39): what is left` — always with a TASK.md id, so it can be found from the plan.
- No commented-out code; delete it (git remembers).

```ts
// Good — explains a non-obvious reason
// Conditional increment: the capacity check and the claim are one statement.

// Bad — repeats the code
// increment open leads by one
```

## 5. Errors and logging

- Throw `ApiError` helpers (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`) from `lib/http/errors.ts`; wrap route handlers with `handle()`.
- Error `code` values are stable snake_case; `message` is safe to show a user. Never include stack traces, SQL or secrets in responses.
- Background jobs: throw to make QStash retry; return normally for non-retryable bad input (and log why).
- Log with `log.info/warn/error(msg, fields)` from `lib/log.ts` — never `console.log` in app code. Pass fields as an object; redaction handles phones and secrets, but don't log payload bodies.

## 6. Database code

- All tenant writes inside `withTenant(ctx, async (tx) => …)`; one transaction per business change.
- Pure reads (lists, dashboards, reports, exports) use `withTenantRead(…)` — read replica by least connections. Never read-then-write through it.
- Use Drizzle's query builder; raw `sql\`…\`` only for things the builder can't express, always parameterised (never string-concatenate values).
- Dedupe and idempotency via unique indexes + `onConflictDoNothing()`; never find-then-insert.
- Lock with `.for("update")` when a later write depends on a read.
- New query → matching index in `lib/db/schema.ts` (tenant_id first) and a row in DESIGN.md §2.5. Search goes through `searchContacts()`; escape `%`/`_` with `escapeLike()`.
- No `fetch`, QStash or Redis calls inside a transaction: commit, then call out.
- Schema changes only in `lib/db/schema.ts` → `npm run db:generate` → review SQL → commit.

## 7. Async, time and money

- Always `await` or deliberately handle promises; no floating promises. Use `Promise.all` for independent work.
- Every outbound `fetch` has a timeout (`AbortSignal.timeout(…)`).
- Store `Date`/`timestamptz` in UTC. Tenant-local logic (working hours, "today") uses the tenant timezone via `Intl` (see `localParts` in `assignment/eligibility.ts`).
- Amounts (future billing): integer paise, never floats.

## 8. Testing

- Every domain rule gets a unit test: dedupe, assignment, signatures, state transitions, normalisation, phone rules.
- Database behaviour (RLS, `ON CONFLICT`, locking) gets an integration test on PGlite — it uses the real migrations.
- External services in tests: fake them (`vi.mock` for QStash, `fakeRedis()` helper); never call real providers.
- Every new API route: a cross-tenant test (tenant A cannot see or change tenant B).
- Bug fix = a test that fails before the fix.
- Test data: invented names and numbers (`98XXXXXXXX` style); never real customer data.

## 9. Git and pull requests

- Branch from `main`: `feat/T1.11-auth`, `fix/T1.38-callerdesk-status`.
- Commit messages: imperative, with the task id — `T1.21 merge duplicate leads on conflict`.
- One logical change per PR; update docs in the same PR ([API.md](API.md) for routes, [DESIGN.md](DESIGN.md)/[RULE.md](RULE.md) for model or rules, [TASK.md](TASK.md) status, [MEMORIE.md](MEMORIE.md) for decisions).
- Never commit `.env.local`, `.vercel/`, real data exports, or generated build output.
- PR checklist: lint, typecheck, tests, build green; [SECURITY.md §7](SECURITY.md#7-before-every-release-checklist) items checked.

## 10. Dependencies

- Prefer the platform and existing deps before adding a package; justify new ones in the PR.
- Pin with `^` ranges; commit `package-lock.json`.
- No packages that need native long-running processes (we run on serverless functions).
