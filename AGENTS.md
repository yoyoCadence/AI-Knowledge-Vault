# AGENTS.md — rules for any AI agent or engineer working in this repository

## 0. Before you change anything

1. Read `active-plan.md` (what is in flight right now) and `task.md` (task status).
2. Read `docs/HANDOFF.md` (current state, known issues, next steps).
3. Read the doc for the area you touch: `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`,
   `docs/SECURITY.md`, `docs/IMPORT_PIPELINE.md`, `docs/SEARCH_DESIGN.md`,
   `docs/BACKUP_RECOVERY.md`, `docs/API_CONTRACT.md`.
4. Decisions with rationale are in `docs/DECISIONS.md` (ADRs). Do not silently reverse one; add a
   new ADR instead.

<!-- BEGIN:nextjs-agent-rules -->

## Next.js: this is NOT the Next.js you know

This repo uses Next.js 16 (App Router). APIs and conventions differ from older training data:
`proxy.ts` replaced `middleware.ts`, and request APIs are async. Read the version-matched docs in
`node_modules/next/dist/docs/` before writing Next.js code.

<!-- END:nextjs-agent-rules -->

## 1. Non-negotiable product rules (docs/PRODUCT_SPEC.md §1.3)

- **Originals are immutable.** Never write code that updates `file_assets` immutable columns or
  overwrites `ws/*/originals/*` objects. A DB trigger and conditional writes enforce this; do not
  weaken them.
- **Private by default.** Every query on user data is scoped by `workspace_id` from the `Actor`.
  Out-of-scope objects return 404, identical to "missing".
- **No AI dependency for core features.** No fake data, fake buttons, fake AI output or fake
  success. Unbuilt features use the `FutureFeature` page component.
- **Untrusted content stays untrusted.** Imported HTML, JS and PDF are never executed on the app
  origin and never injected with `dangerouslySetInnerHTML`.
- **No private data in the repo.** Never commit private research or real credentials. Test
  fixtures are synthetic.

## 2. Architecture rules (enforced by ESLint where possible)

- `src/components/**` must not import `@/infrastructure/*` or `@/modules/*` (type imports are
  allowed).
- `src/modules/**`, `src/infrastructure/**`, `src/lib/**` and `src/worker/**` must not import
  `next/*`.
- Storage keys are built only with `storageKeys.*`. SQL goes only through Drizzle or the `sql`
  template; `sql.raw` is banned outside schema DDL.
- Background work goes through `modules/jobs`: call `enqueueJob` inside the business transaction.
  Handlers must be idempotent and explain why in their header comment.
- Schema changes:
  1. Edit `src/infrastructure/database/schema/*`.
  2. Run `pnpm db:generate --name <change>`.
  3. Review the generated SQL and commit it.

  Never run `drizzle-kit push` against shared databases.

## 3. Definition of done for a task

- Code plus tests: unit tests for pure logic, and integration tests against real Postgres for
  anything that touches SQL or storage.
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.
- Docs are updated: the API_CONTRACT status column, ROADMAP and task.md status, and HANDOFF.md.
- If something cannot be verified, write down why. Never mark it done.

## 4. Workflow

- Work in vertical slices, for example upload → store → persist → read back → verify hash → test.
- One PR per coherent slice. Merge to `main` when CI is green, then continue with the next slice.
- If context is running out:
  1. Stop starting new work.
  2. Update `active-plan.md`, `task.md` and `docs/HANDOFF.md` with what is done, what is in
     progress, known bugs, and the exact next files and commands.
  3. Commit and push.

## 5. Local environment quick reference

```bash
pnpm install
cp .env.example .env.local        # then generate real secrets (openssl rand -base64 48)
pnpm db:migrate                   # needs a local Postgres (DATABASE_URL)
pnpm dev                          # web on http://localhost:3000 (preview origin http://127.0.0.1:3000)
pnpm worker:dev                   # background worker
DATABASE_URL_TEST=... pnpm test   # unit + integration (integration resets the *test* database)
```

Optional: `S3_TEST_ENDPOINT=http://127.0.0.1:5055 pnpm test` runs the S3 adapter suite against a
local `moto_server` (`pip install "moto[server]"`).

## 6. Language

The UI defaults to Traditional Chinese (zh-TW) via `src/lib/i18n`. Product docs (README,
PRODUCT_SPEC, ROADMAP) are in Traditional Chinese; engineering docs are in English.
