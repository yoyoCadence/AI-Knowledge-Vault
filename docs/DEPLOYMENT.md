# Deployment

Status: **local development is implemented. Staging and production are designed but not yet
deployed.** No cloud account has been provisioned by the implementation agent. The owner
must supply credentials (see §6).

## 1. Environments

| Env        | Web                                  | Worker                   | Database                                                    | Storage                                    | Preview origin                                                                     |
| ---------- | ------------------------------------ | ------------------------ | ----------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Local      | `pnpm dev` → `http://localhost:3000` | `pnpm worker:dev`        | local Postgres 16 (`vault_dev`)                             | `LocalStorageAdapter` in `./.data/storage` | `http://127.0.0.1:3000` (different host → different origin; cookies are host-only) |
| Test/CI    | `next start` (E2E only)              | spawned by the E2E setup | `postgres:16` service, `vault_test`                         | local adapter in a temp dir                | `http://127.0.0.1:3100`                                                            |
| Staging    | container (`web`)                    | container (`worker`)     | Neon branch `staging`                                       | R2 bucket `vault-staging`                  | `https://staging-preview.<preview-domain>`                                         |
| Production | container (`web`)                    | container (`worker`)     | Neon `main` (pooled URL for web, direct URL for migrations) | R2 bucket `vault-prod`                     | `https://preview.<separate-registrable-domain>`                                    |

## 2. Hosting options

The worker must be a long-lived process. Serverless functions cannot host it (ARCHITECTURE
§1, ADR-005).

| Option                                                              | Web                                                         | Worker                       | Cost (indicative, verify current pricing) | Notes                                                                                                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A (recommended): container platform** (Fly.io / Railway / Render) | same image, process `web`                                   | same image, process `worker` | ~5–10 USD/mo                              | one image, two process groups; both hostnames point at `web`                                                                                                    |
| B: Vercel + container worker                                        | Vercel (Hobby is personal and non-commercial; check limits) | Fly/Railway/Render           | 0 + ~5 USD/mo                             | function duration limits do not matter because web does no long work; the worker needs the same env                                                             |
| C: single VPS (Hetzner etc.)                                        | Docker Compose `web`                                        | Docker Compose `worker`      | ~5 USD/mo                                 | can use local storage with `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true` on a persistent volume, but R2 is still recommended; backups are the owner's responsibility |

Free tiers change. Do not plan on any free tier being permanent. Known constraints (as of
writing, to be re-verified):

- **Neon free:** 100 CU-hours a month and 1 GB of storage per project (2026-11). Compute
  suspends after 5 minutes without queries and resumes in a few hundred milliseconds. A
  compute that never sleeps uses about 182 CU-hours a month (0.25 CU), and the free plan then
  suspends it until the next month, from about day 16. **On the free plan, follow §5.8**, or
  the worker's polling and the platform's health checks keep it awake. The alternatives are a
  paid plan (always on at 0.25 CU: about 19 USD a month at the Launch rate) or a Postgres
  that does not bill by compute hour.
- **R2 free:** 10 GB storage, plus Class A/B operation limits.
- **Container platforms:** usually no free always-on worker.

## 3. Build and runtime

- `next.config.ts` sets `output: "standalone"`.
- `pnpm build` → `.next/standalone`. `pnpm build:node` → `dist/worker.mjs` + `dist/db-migrate.mjs` (esbuild bundle;
  native `sharp` stays external).
- `Dockerfile` (multi-stage) produces one image with both entrypoints:
  - `web`: `node server.js`
  - `worker`: `node dist/worker.mjs`
- Graceful shutdown: on `SIGTERM` the worker stops claiming, waits up to
  `WORKER_SHUTDOWN_GRACE_MS` for running jobs, then exits. Unfinished jobs are recovered by
  lease expiry.

## 4. Configuration (secrets)

See `.env.example` for the full annotated list. Required in staging and production:

| Variable                                                                                                                                                   | Notes                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                                                                                                                                  | `production`/`staging` — **required** (startup fails if missing while `NODE_ENV=production`)        |
| `APP_ORIGIN`                                                                                                                                               | e.g. `https://vault.example.com`                                                                    |
| `PREVIEW_ORIGIN`                                                                                                                                           | a different registrable domain recommended, e.g. `https://preview.example-usercontent.net`          |
| `DATABASE_URL`                                                                                                                                             | Neon **pooled** connection string for web/worker; `DATABASE_URL_DIRECT` (non-pooled) for migrations |
| `BETTER_AUTH_SECRET`, `PREVIEW_TOKEN_SECRET`, `LOCAL_STORAGE_SIGNING_SECRET`                                                                               | ≥ 32 random chars each, all different (`openssl rand -base64 48`)                                   |
| `STORAGE_DRIVER=s3`, `S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | R2 API token scoped to one bucket                                                                   |
| `WORKER_IDLE_POLL_INTERVAL_MS`, `WORKER_WAKE_URL`, `WORKER_WAKE_SECRET`, `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST`                                        | Only for a database that scales to zero (Neon free plan): §5.8                                      |

## 5. Procedures

### 5.1 Database migrations

1. Take a backup: a Neon branch snapshot plus `scripts/backup/pg-dump.sh`.
2. Run `DATABASE_URL=$DATABASE_URL_DIRECT pnpm db:migrate`. This is a one-off release step
   that runs before the new web and worker start. Never run it on every boot of multiple
   replicas.
3. Deploy web and worker.
4. Destructive changes follow DATA_MODEL §6 (expand/contract).

### 5.2 R2 bucket setup

1. Create the buckets `vault-prod` and `vault-staging`. Keep public access **disabled**, with
   no custom domain and no r2.dev URL.
2. Create an API token with Object Read & Write, scoped to that one bucket.
3. CORS (needed for direct browser upload and download):
   ```json
   [
     {
       "AllowedOrigins": ["https://vault.example.com"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["content-type", "content-length"],
       "ExposeHeaders": ["etag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
4. Optional: add a lifecycle rule that deletes `ws/*/staging/` objects older than 3 days (a
   safety net behind the cleanup job).
5. **Verify each bucket before first use**, from a checkout after `pnpm install`. This needs
   no database. Run it for staging and for production: it works only under a fresh
   `vault-adapter-test-<id>/` prefix, which it deletes afterwards.

   ```bash
   S3_TEST_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
   S3_TEST_BUCKET=vault-staging S3_TEST_REGION=auto \
   S3_TEST_ACCESS_KEY_ID=… S3_TEST_SECRET_ACCESS_KEY=… \
   S3_TEST_CORS_ORIGIN=https://staging.<your-domain> \
   pnpm storage:verify
   ```

   `S3_TEST_CORS_ORIGIN` is the app origin that this bucket's CORS rule allows (step 3).
   A missing variable is an error, never a skipped check.

   All 7 tests must pass. They check:
   - put, head, get, paged list and delete;
   - **conditional writes:** a write with `If-None-Match` must refuse to overwrite. If it
     doesn't, the immutability of originals cannot rely on the provider. Stop and decide
     (SECURITY.md) before storing anything.
   - presigned downloads (with `Content-Disposition`) and uploads carry the exact bytes;
   - **presigned upload bounds:** an upload of another size or type is refused. If it isn't,
     only the completion check enforces the declared size.
   - **CORS:** the app's origin may PUT with `content-type`, and no other origin may.

   Notes:
   - A CORS change can take a minute to apply. Rerun if the CORS test fails right after an
     edit.
   - Only an interrupted run leaves objects behind. Delete the `vault-adapter-test-` prefix
     by hand.
   - Run it from your own machine, never paste the token into a chat or commit it. A cloud
     agent session cannot run it for you: S3 requests are signed with the secret key inside
     the process, so a proxy that injects a header cannot stand in for it.

   **If a test fails:**

   | Failing test            | What it means                                                | What to do                                                                                                                                                                                                                                             |
   | ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | CORS                    | The rule from step 3 is missing, or names another origin     | Fix the rule, wait a minute, rerun. Required: browser uploads fail without it.                                                                                                                                                                         |
   | Presigned upload bounds | The provider accepts another size or type on a presigned PUT | Acceptable. `completeItem` compares the stored size with the declared one and fails the item (`SIZE_MISMATCH`), and the worker hashes what it reads. Record it in §7.                                                                                  |
   | Conditional write       | The provider ignores `If-None-Match: *` and overwrites       | **Stop. Store nothing there.** Immutable originals are a non-negotiable rule (AGENTS.md §1, ADR-006), and conditional writes are one of the two things that enforce it. Use a provider that honours them, or the owner decides otherwise in a new ADR. |
   | Anything else           | The adapter cannot work with this provider                   | Stop. Do not store anything there.                                                                                                                                                                                                                     |

   Input for that decision, should it ever be needed (not a decision):
   - `storeOriginal` (`src/modules/files/originals.ts`) writes from the worker's own
     temporary file, the same file whose SHA-256 became the key, and a restore verifies every
     archived original's hash before writing it. So without conditional writes, a repeated
     write still carries the same bytes.
   - It is still an overwrite. A restore passes every archived original to `storeOriginal`,
     existing ones included, so on such a provider existing objects are rewritten. Neither the
     `file_assets` trigger nor the integrity check prevents that; the check only finds damage
     afterwards. Write-once would then rest on the code alone, and a future bug could replace
     an original.
   - A decision to accept that would need, at least, the independent copy with versioning or
     Object Lock (BACKUP_RECOVERY layer 4) before anything irreplaceable is imported, and an ADR
     that changes the rule in AGENTS.md §1.

### 5.3 Domains

- App: `vault.<your-domain>` → web.
- Preview: `preview.<another-domain>` → **the same web service**. `proxy.ts` routes by host.
  A separate registrable domain avoids same-site cookie and permission bleed. A subdomain of
  the app domain works, but is weaker. The same hostname on another port or scheme is refused
  at startup: browsers send a host's cookies to all its ports.
- Both need TLS. Set HSTS on the app domain.

### 5.4 First run

1. Run `pnpm db:migrate`.
2. Run `ADMIN_EMAIL=… ADMIN_NAME=… node dist/admin-create.mjs` in the container
   (`pnpm admin:create` locally). It prompts for a password, or reads `ADMIN_PASSWORD` when
   there is no TTY, and creates the user, workspace and owner membership.
3. Log in at `APP_ORIGIN/login`.

A forgotten password: there is no email reset. In the container, run
`ADMIN_EMAIL=… node dist/admin-reset-password.mjs` (`pnpm admin:reset-password` locally). It
reads the new password like `admin:create`, signs the user out everywhere and is audited.

### 5.5 Backups

See BACKUP_RECOVERY §5. Schedule `scripts/backup/pg-dump.sh` and `rclone sync` on a machine
or service with **separate credentials** (for example a home NAS cron job or a GitHub Actions
scheduled workflow with its own secrets).

### 5.6 Reverse proxy and client IPs

Login rate limiting keys on the client IP taken from `x-forwarded-for`. The platform's edge
proxy must overwrite, not append, this header. Alternatively, set `TRUSTED_PROXIES` (which feeds
Better Auth `advanced.ipAddress.trustedProxies`) to the platform's proxy ranges. If neither is done, clients
can spoof IPs to evade the per-IP limit.

Share links (`/s/*`, and their previews on the preview host) are rate limited per client
address too, with the same trust rules (`rateLimitAddress`; IPv6 counts by /64): it believes
`X-Forwarded-For` from `TRUSTED_PROXIES`, or a single-hop header. Exposed without a proxy that
overwrites the header, a client chooses its own address: it can evade the limit, or spend
another address's budget. Requests with no usable address share one "unknown" budget (120 a
minute for all of them together). Deploy behind the platform proxy and configure it.

### 5.7 After every deployment: check the client address (required)

Sign-in is limited to 5 attempts a minute **per client address**; share links are limited per
address too (§5.6). Both are only as good as the address the app believes. A platform proxy
that appends to `X-Forwarded-For` (most do) plus an empty `TRUSTED_PROXIES` has one of two
results, and neither is visible in normal use:

- the app believes the client's own header, so anyone can rotate fake addresses and guess
  passwords without limit;
- or no request has a usable address, so every visitor shares one budget, and one person can
  lock everyone out.

Run both checks after the first deployment and after any change of host, proxy, CDN or
`TRUSTED_PROXIES`. Record the result in §7.

1. **Forged addresses are not believed.** From your own machine (replace `APP`):

   ```bash
   for i in 1 2 3 4 5 6; do
     curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://APP/api/auth/sign-in/email" \
       -H "content-type: application/json" -H "origin: https://APP" \
       -H "X-Forwarded-For: 203.0.113.$i" \
       -d '{"email":"nobody@example.invalid","password":"not-the-password-123"}'
   done
   ```

   Expected: five `401`, then `429`. Six `401` means each forged address got its own
   budget. Fix the proxy (overwrite the header) or set `TRUSTED_PROXIES`, then rerun. Wait a
   minute before running it again: the limit window is 60 s.

2. **The real address is recorded.** In the database:

   ```sql
   select ip_address, created_at from audit_logs
   where action = 'auth.login.failed' order by created_at desc limit 6;
   ```

   Expected: your own public address on every row. `203.0.113.x` means forged headers are
   believed (check 1 should have caught it). An empty address, or the proxy's address, means
   every visitor shares one budget: set `TRUSTED_PROXIES` to the platform's proxy ranges.

### 5.8 A database that scales to zero (Neon free plan)

ADR-024 has the reasoning. The database must be left alone when nobody uses the app: the
worker polls rarely when idle, the web wakes it when it enqueues work, and nothing probes the
database on a timer.

1. **Neon:** fix the compute at 0.25 CU (minimum = maximum), so a burst of work cannot
   autoscale it and spend the month's hours faster. Keep scale to zero on (the free plan
   cannot turn it off).
2. **Worker** (environment of the `worker` process):

   | Variable                       | Value                                                    |
   | ------------------------------ | -------------------------------------------------------- |
   | `WORKER_IDLE_POLL_INTERVAL_MS` | `1800000` (30 minutes)                                   |
   | `WORKER_HEALTH_PORT`           | `3901` (any free port)                                   |
   | `WORKER_HEALTH_HOST`           | `::` (listen on the private network; IPv4 and IPv6)      |
   | `WORKER_WAKE_SECRET`           | `openssl rand -base64 48`; not equal to any other secret |

3. **Web** (environment of the `web` process):
   - `WORKER_WAKE_SECRET`: the same value.
   - `WORKER_WAKE_URL`: the worker's port on the platform's private network, ending in
     `/wake`. The platform docs give the exact host name. Typical forms (verify them):
     - Railway: `http://<worker service>.railway.internal:3901/wake`.
     - Fly.io, one app with two process groups: `http://worker.process.<app>.internal:3901/wake`.
     - Render: a background worker takes no inbound traffic. Run the worker as a private
       service instead (same image, same command): `http://<service>:3901/wake`.
     - Docker Compose: `http://worker:3901/wake`.
   - The web and worker images are the same, so setting all of the above on both is fine.
     The worker wakes itself directly; it never calls its own URL.
4. **Health checks:** point the platform's health check, and any uptime monitor, at
   `/api/health/live`. It touches neither database nor storage. `/api/health` runs a query,
   so probing it every few seconds keeps the database awake all month. Use it by hand, or
   in a deploy step.
5. **Check, after deploying:**
   - Leave the app alone for 10 minutes, then import a small file. It should be processed
     within seconds. If it waits (up to 30 minutes), no wake arrived: check
     `WORKER_WAKE_URL` and the secret on the web. An unreachable or refusing worker makes the
     web log "could not wake the worker" (at most once a minute).
   - After a quiet hour, Neon's console should show the compute as idle.
   - Check the month's compute usage after a few days. Expected: about 1 to 1.5 CU-hours
     a day idle (48 polls × about 5 minutes awake × 0.25 CU, a little more for the hourly
     maintenance jobs), plus about 0.25 CU-hour per hour of use. The free plan has 100 a
     month.
   - Record the result in §7 ("Wake check").

## 6. What the owner must provide to deploy

1. A Neon project, with its connection strings (pooled and direct).
2. A Cloudflare R2 bucket and a bucket-scoped API token.
3. Two domains or hostnames, for the app and the preview.
4. A container host account (Fly.io, Railway or Render) or a VPS.
5. An independent backup destination (B2 bucket, NAS, etc.) and its credentials.
6. Generated secrets (`openssl rand -base64 48` × 3, and a fourth, `WORKER_WAKE_SECRET`, on a
   database that scales to zero, §5.8).

## 7. Deployment record

One row per environment, kept current. An agent that finds a deployed environment here whose
checks are not all done asks the owner to finish them before other work (AGENTS.md §0).

| Environment | Host and proxy   | `TRUSTED_PROXIES` | R2 verify (§5.2) | Client address checks (§5.7) | Wake check (§5.8, scale-to-zero only) | Date |
| ----------- | ---------------- | ----------------- | ---------------- | ---------------------------- | ------------------------------------- | ---- |
| production  | not deployed yet | —                 | not run          | not run                      | not run                               | —    |
| staging     | not deployed yet | —                 | not run          | not run                      | not run                               | —    |
