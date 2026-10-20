# Handoff

The living state of the project, for an agent or engineer with no access to prior conversations.
Update it at the end of every PR.

## 1. Snapshot (2026-10-20, after PR 1 — Phase 0)

**Works and is tested**

- Toolchain:
  - TypeScript 6 strict, ESLint with module-boundary rules, Prettier
  - Vitest projects `unit` and `integration`
  - Playwright 1.56.1 pinned to the container's Chromium build 1194
- Configuration: Zod env validation (`src/infrastructure/config/env.ts`).
- Database:
  - Drizzle schema plus the versioned migration `drizzle/0000_foundation.sql`
  - Integration global setup drops the test schema and re-applies all migrations on every run
- Storage:
  - `StorageAdapter` interface (`src/infrastructure/storage/types.ts`)
  - `LocalStorageAdapter`, with atomic conditional writes and HMAC-signed URLs
  - `S3StorageAdapter`, tested against `moto_server` (pip `moto[server]`)
- Jobs:
  - `src/modules/jobs`: enqueue (idempotent, transactional), claim (SKIP LOCKED), heartbeat
    lease, complete, fail with backoff, recovery of expired leases, manual retry and cancel
  - `JobWorker` with bounded concurrency, timeouts and graceful stop
  - Worker entry `src/worker/main.ts`; registry `src/worker/registry.ts` is empty until P1A
- Web:
  - App shell (zh-TW, light/dark, mobile drawer) and Future Feature pages
  - `/api/health`
  - `src/proxy.ts` host routing: `/p/*` is only served on `PREVIEW_ORIGIN`, and only `/p/*` is
    served there
- CI: `.github/workflows/ci.yml` runs Postgres 16 and moto, then format, lint, typecheck, test
  and build.

**Not done or not verified**

- The Dockerfile is written but has never been built: Docker Hub pulls are blocked in the
  development container. Verify it in CI or locally before relying on it.
- The S3 adapter has not been verified against real Cloudflare R2, in particular how R2
  enforces the signed `content-length` on presigned PUTs. Verify on staging.
- No auth yet, so all pages are currently public. The only data exposed is static placeholder
  content and the health endpoint.

## 2. How to run

See `AGENTS.md` §5 and `README.md`. In the original development container:

- Postgres 16 was started with `service postgresql start`.
- Role `vault`/`vault` with databases `vault_dev` and `vault_test`.

## 3. Conventions worth knowing

- Every table's ID is an app-generated UUIDv7 (`idColumn()` in `schema/_shared.ts`).
- CHECK constraints for text enums are built with `oneOf()`, which inlines escaped literals.
  DDL cannot take bind parameters.
- `src/app/api/_lib/http.ts` provides the route-handler helpers:
  - `json`, `errorResponse` (error ids)
  - `assertSameOrigin` (CSRF)
  - `parseJsonBody`/`parseQuery` (Zod, never echoes values)
- The logger (`getLogger`) redacts common secret keys. Still, never log document text.

## 4. Next steps (exact)

PR 2 — **P1A-AUTH**:

1. Schema is already present: `users`, `sessions`, `auth_accounts`, `auth_verifications`,
   `auth_rate_limits`.
2. Create `src/modules/auth/auth.ts` with `betterAuth({...})`:
   - `database: drizzleAdapter(getDb(), { provider: "pg", schema: {...} })`
   - `user.modelName = "users"`, `session.modelName = "sessions"`,
     `account.modelName = "auth_accounts"`, `verification.modelName = "auth_verifications"`,
     `rateLimit.modelName = "auth_rate_limits"`. Check the adapter's schema key expectations.
   - `emailAndPassword { enabled: true, disableSignUp: true, minPasswordLength: 12 }`
   - `advanced.database.generateId = () => newId()`
   - `rateLimit { enabled: true, storage: "database", customRules: { "/sign-in/email": { window: 60, max: 5 } } }`
   - `telemetry { enabled: false }`
   - `baseURL = APP_ORIGIN`, `trustedOrigins = [APP_ORIGIN]`
3. Mount `src/app/api/auth/[...all]/route.ts` with `toNextJsHandler` (`better-auth/next-js`).
4. `src/modules/auth/actor.ts`:
   - `getActor(headers)` → session → membership → `{ userId, workspaceId, role }`
   - `requireActor()` throws `UNAUTHENTICATED`
   - `can(actor, action)`
5. `scripts/admin-create.ts`:
   - Reads the password from a TTY prompt or the `ADMIN_PASSWORD` env var.
   - Hashes with Better Auth's `hashPassword` (`better-auth/crypto`).
   - Inserts the user, credential account, workspace and owner membership in one transaction.
   - Is idempotent: refuses if the email exists.
6. Dashboard layout: redirect to `/login` without a session. Add the login page (a form calling
   the Better Auth client), logout, and Settings → sessions list and revoke.
7. Tests:
   - sign-in success
   - wrong password → 401 and an audit row
   - sign-up endpoint disabled
   - rate limit after 5 attempts
   - session revoke
   - `requireActor` rejects anonymous requests
