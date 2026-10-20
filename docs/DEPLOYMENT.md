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

- **Neon free:** small storage cap; compute suspends when idle (cold-start latency).
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
| `APP_ENV`                                                                                                                                                  | `production`/`staging`                                                                              |
| `APP_ORIGIN`                                                                                                                                               | e.g. `https://vault.example.com`                                                                    |
| `PREVIEW_ORIGIN`                                                                                                                                           | a different registrable domain recommended, e.g. `https://preview.example-usercontent.net`          |
| `DATABASE_URL`                                                                                                                                             | Neon **pooled** connection string for web/worker; `DATABASE_URL_DIRECT` (non-pooled) for migrations |
| `BETTER_AUTH_SECRET`, `PREVIEW_TOKEN_SECRET`, `LOCAL_STORAGE_SIGNING_SECRET`                                                                               | ≥ 32 random chars each, all different (`openssl rand -base64 48`)                                   |
| `STORAGE_DRIVER=s3`, `S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | R2 API token scoped to one bucket                                                                   |

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

### 5.3 Domains

- App: `vault.<your-domain>` → web.
- Preview: `preview.<another-domain>` → **the same web service**. `proxy.ts` routes by host.
  A separate registrable domain avoids same-site cookie and permission bleed. A subdomain of
  the app domain works, but is weaker.
- Both need TLS. Set HSTS on the app domain.

### 5.4 First run

1. Run `pnpm db:migrate`.
2. Run `ADMIN_EMAIL=… pnpm admin:create`. It prompts for a password and creates the user and
   workspace.
3. Log in at `APP_ORIGIN/login`.

### 5.5 Backups

See BACKUP_RECOVERY §5. Schedule `scripts/backup/pg-dump.sh` and `rclone sync` on a machine
or service with **separate credentials** (for example a home NAS cron job or a GitHub Actions
scheduled workflow with its own secrets).

## 6. What the owner must provide to deploy

1. A Neon project, with its connection strings (pooled and direct).
2. A Cloudflare R2 bucket and a bucket-scoped API token.
3. Two domains or hostnames, for the app and the preview.
4. A container host account (Fly.io, Railway or Render) or a VPS.
5. An independent backup destination (B2 bucket, NAS, etc.) and its credentials.
6. Generated secrets (`openssl rand -base64 48` × 3).
