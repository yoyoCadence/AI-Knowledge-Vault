# Backup, Export & Disaster Recovery

Implements FR-BAK-*. The rule: **an export is not a backup until a restore from it has been
verified.** `tests/integration/backup-roundtrip.test.ts` proves this on every CI run.

## 1. Scope and priority

| Data                                            | In portable export                                    | Backup priority | Regenerable?                                |
| ----------------------------------------------- | ----------------------------------------------------- | --------------- | ------------------------------------------- |
| Original files (`file_assets` bytes)            | yes (`originals/`)                                    | **P0**          | no                                          |
| Artifacts, versions, projects, source metadata  | yes                                                   | **P0**          | no                                          |
| Collections, tags, notes, reading states        | yes                                                   | **P0**          | no                                          |
| Extracted text (normalized markdown)            | yes (`normalized/`)                                   | P1              | yes, from originals                         |
| Sections, chunks, search vectors                | no                                                    | P2              | yes, via re-extraction and re-index         |
| Derived preview files, thumbnails               | no                                                    | P2              | yes, from originals                         |
| Share links                                     | config only (label, flags, expiry); **no token hash** | P1              | links must be re-issued                     |
| Embeddings and AI results (Phase 2+)            | optional                                              | P2              | yes, at cost                                |
| Users, password hashes, sessions, auth accounts | **never**                                             | —               | the admin is re-created with `admin:create` |
| Audit logs                                      | optional (`--include-audit`)                          | P2              | no, but not needed for restore              |

## 2. Portable export format (current: v3)

File name: `knowledge-vault-export-{workspaceSlug}-{YYYYMMDDTHHmmssZ}.zip`

```
README.txt                     # human-readable explanation of this format (no app needed)
manifest.json                  # format, versions, counts, created_at, source app version, encryption: "none"
schema-version.json            # {"format":"ai-knowledge-vault-export","formatVersion":3,"dbMigration":"0008_…"}
metadata/
  workspace.json               # {id, name, slug}
  research_projects.json
  artifacts.json               # array; includes visibility, sensitivity, review_status, current_version_id
  artifact_versions.json       # includes source metadata, analysis, version_number, primary_file_id
  file_assets.json             # id, sha256, byte_size, mime_type, original_filename, archive_path
  artifact_files.json
  tags.json                    # v2+: [{id, name, createdAt, updatedAt}]
  artifact_tags.json           # v2+: [{artifactId, tagId, createdAt}]
  collections.json             # v3+: [{id, parentId, kind, name, description, sortOrder, createdAt, updatedAt}]
  collection_items.json        # v3+: [{collectionId, artifactId, position, addedAt}]
  artifact_notes.json
  artifact_reading_states.json # user ids replaced by "owner"
  share_links.json             # without token_hash
originals/{sha256[0:2]}/{sha256}/{sanitized_original_filename}
normalized/{artifact_version_id}.md       # active extraction, with YAML front matter (title, artifact, version, language, extraction method/version)
checksums.sha256               # "<sha256>  <path>" for every file except itself and manifest.json; verifiable with `sha256sum -c`
```

Properties:

1. **Independent of this app.** JSON with documented fields (`README.txt` describes each),
   original filenames preserved, and Markdown text.
2. **Originals fully retrievable.** The bytes are the originals, and the path includes the
   SHA-256.
3. **Versioned.** `formatVersion` (integer) plus the DB migration tag. Every format change
   that adds data bumps the version (ADR-018): v1 = the original layout; v2 adds
   `tags.json` and `artifact_tags.json`; v3 adds `collections.json` and
   `collection_items.json`. Exports are always written in the latest version.
4. **Integrity.** `checksums.sha256` covers every entry except itself and `manifest.json`.
   `manifest.json` carries the SHA-256 of `checksums.sha256`, so the manifest is the root of
   trust and the two files together cover the whole archive. (Listing the manifest in the
   checksums would be circular.)
5. **Migratable.** Restore reads every supported `formatVersion` (today v1–v3; a v1
   archive simply has no tags, a v2 archive no collections). An app that does not know a version refuses the archive
   with `UNSUPPORTED_EXPORT_FORMAT` instead of silently dropping data it cannot read.
6. **Re-importable.** Import & Backup → 從備份還原 (`POST /api/restores`), or `pnpm backup:restore <file>`.
7. **No secrets.** See §1.

## 3. Export process

- Triggered by `POST /api/exports`, the Import & Backup page, or the CLI
  `pnpm backup:export --workspace <slug> --out <file>` (`node dist/backup-export.mjs` in images).
- Job `export.create`:
  1. read rows (workspace-scoped)
  2. stream originals from storage into the ZIP while hashing
  3. write metadata, normalized text and checksums
  4. upload to `ws/{ws}/exports/{exportId}.zip`
  5. record `byte_size` and `sha256` in `export_runs`
- Download: `GET /api/exports/:id/download` returns a 5-minute signed URL. Each download is
  audited.
- Retention: export archives expire after 7 days (`expires_at`), and the hourly
  `maintenance.cleanup_exports` job deletes them. **The exported file is the user's copy**; the app's storage is not the backup
  destination.

## 4. Encryption

- **Phase 1A (implemented):** archives are **unencrypted**. The UI and CLI warn about this
  explicitly. The procedure for encrypting at rest uses the open `age` format with a
  passphrase or recipient key:
  ```bash
  age --passphrase -o export.zip.age export.zip      # or: age -r age1… -o export.zip.age export.zip
  age -d -o export.zip export.zip.age                # decrypt anywhere, no app needed
  ```
- **P1A-ENC (planned):** built-in `age` encryption (passphrase/scrypt or X25519 recipient)
  during export. Rules:
  - The key or passphrase is never stored in the archive or in the database.
  - `manifest.json` stays outside the encryption envelope in a sidecar
    `*.manifest.json`, so a backup can be inventoried without decryption.
- **Key custody guidance:** store the passphrase or identity in a password manager **and** an
  offline copy. Losing it means the backup is unrecoverable by design.

## 5. Backup strategy (3-2-1)

| Copy                       | Medium / provider                                              | Mechanism                                                                                                                            | Frequency                |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 1. Primary                 | Neon Postgres + R2 bucket                                      | live                                                                                                                                 | —                        |
| 2. DB point-in-time        | Neon PITR (plan-dependent retention)                           | provider                                                                                                                             | continuous               |
| 3. Independent DB dump     | Different provider/account (e.g. Backblaze B2, or a local NAS) | `scripts/backup/pg-dump.sh` (custom-format `pg_dump`)                                                                                | daily                    |
| 4. Independent object copy | Different provider/account                                     | `rclone sync r2:vault-primary b2:vault-backup` with `--backup-dir` versioning (deletes on the primary don't propagate destructively) | daily                    |
| 5. Portable export         | Owner's offline storage (encrypted with `age`)                 | `pnpm backup:export`                                                                                                                 | weekly / before upgrades |

"Bucket deleted" scenario: copies 3 and 4 live under different credentials, so the primary's
credentials cannot delete them. Use B2 Object Lock or append-only keys where available.

## 6. Restore process

Job `restore.run`. Steps, each recorded in `restore_runs.report`:

1. **Format check.** The archive must be a ZIP with safe entries (the same limits as import).
   `manifest.json` and `schema-version.json` must be present and parse. `formatVersion` must
   be supported.
2. **Integrity.** Recompute SHA-256 for every entry and compare with `checksums.sha256`. Any
   mismatch → **abort before writing anything** (`CHECKSUM_MISMATCH`, listing the files).
   Each original's path hash must also equal its content hash.
3. **Parse metadata.** Zod-validate every JSON file against the schema of the archive's
   format version, and cross-check it: every reference resolves inside the archive, primary
   ids are unique, (v2) tag names are valid and distinct as the app compares them
   (NFKC, case, spacing), and (v3) collections form a tree (no cycle, at most 7 levels) whose
   names are valid and distinct among siblings. Problems abort before anything is written.
4. **Originals.** For each file asset:
   - If `(target_workspace, sha256)` already exists, reuse it.
   - Otherwise, put the bytes to `ws/{ws}/originals/{sha256}` and insert `file_assets`
     (verified hash).
5. **ID mapping.** Every new ID is _derived_ (UUID v5), never random, so a retried attempt of
   the same run finds the rows an earlier attempt inserted instead of inserting them again.
   - `mode = skip_existing` (default): UUIDs are globally unique, so restoring into a clean
     environment **keeps the original IDs**. A row whose ID already exists in the target
     workspace is kept and reported as `skipped`; one whose ID belongs to another workspace is
     restored under `uuidv5("restore:{targetWorkspace}:{oldId}")`. If that id is taken by
     yet another workspace (an export of an earlier restore restored elsewhere), a second
     derived id `…:fallback` is used, and copy mode works the same way; if both are taken,
     the restore is refused (`CONFLICT`) rather than given a random id that a retry could
     not find again.
   - `mode = copy`: the whole archive is duplicated. Every row gets
     `uuidv5("restore-copy:{restoreId}:{oldId}")`, every FK is rewritten through the mapping,
     `origin_ref = restore:{restoreId}:{oldId}` is set, and the title of an artifact that
     already exists in the target is suffixed `（還原副本）`. Rows an earlier attempt of the
     same run already copied count as `copied` again, not as duplicates.

   Workspace IDs are always remapped to the target workspace. User references
   (`created_by`, `author_id`) map to the restoring user.

   **Tags are merged by name, in both modes.** A tag whose normalized name the target
   workspace already has maps to that tag (reported as `skipped`); the same tag (same id,
   already in the target, perhaps renamed since the export) maps to itself. Only a new name
   is inserted. The unique name constraint makes this hold under retries and concurrent
   restores too, so a restore never creates two tags that look the same.

   **Collections are merged by place and name, in both modes**, parents first. The same
   collection (same id, already ours, perhaps renamed or moved since the export) maps to
   itself; otherwise a collection is inserted under its restored parent, and a sibling there
   with the same name maps to that one instead (`skipped`). Each insert takes the workspace's
   tree lock and re-checks its parent and the depth limit, like creating a collection in the
   app. A collection that cannot be placed (its parent was deleted or renamed meanwhile, or
   merging into a tree whose collections moved since the export would nest it deeper than 7
   levels) is not restored, nor anything below it: counted as `failed` and named in a warning,
   while the rest of the restore goes on.

6. **Rows** are inserted in dependency order inside one transaction per artifact, so a
   failure affects only that artifact, which is reported: projects → collections → tags →
   artifacts → versions → artifact_files → tags/collections links → notes → reading states.
   `current_version_id` is set after versions exist. Tag links are written with each newly
   restored artifact, in its transaction, de-duplicated (two archived tags can map to one
   tag here: merged by name, or the same tag renamed since an older export). An artifact
   that already exists keeps its own tags: a tag removed since the export stays removed
   (versions it lacks are still added). Archived links such an artifact lacks are counted
   (`artifactTagsKept`) and named in a warning, so nothing is dropped silently. Before writing
   links, the target tags are locked `FOR KEY SHARE` in id order, as every tag operation
   locks them, so a restore cannot deadlock with a tag merge; a tag deleted or merged while
   the restore ran is gone, and its link is dropped and counted (`artifactTagsDropped`)
   instead of failing the artifact. Collection items follow the same rules: written with each
   new artifact (target collections locked `FOR KEY SHARE` in id order, before its tags),
   left alone on an artifact that already exists (`collectionItemsKept`), and dropped and
   counted when their collection was not restored or was deleted meanwhile
   (`collectionItemsDropped`).
7. **Rebuild.** One `restore.reextract_version` job per restored version. It re-runs
   extraction and preview generation from the restored original, then indexing (Phase 1B).
   The archived `normalized/*.md` is used as a fallback extraction if re-extraction fails.
8. **Report:**
   - counts per entity (`restored`, `skipped`, `copied`, `failed`; for tags and collections
     `skipped` means merged into an existing one) and the number of tag links and collection
     items written
   - ID-mapping entries (for copies)
   - checksum results
   - warnings
   - duration

### Over HTTP (import page → 備份還原)

1. `POST /api/restores {filename, size}` creates a `queued` run and returns a signed PUT for
   `ws/{ws}/restores/{restoreId}.zip` (TTL 1 hour, size capped by
   `RESTORE_MAX_ARCHIVE_BYTES`).
2. `POST /api/restores/:id/start {mode}` checks the uploaded size and enqueues `restore.run`
   (idempotency key `restore.run:{id}`, up to 3 attempts, timeout `EXPORT_JOB_TIMEOUT_MS`).
3. The job downloads the archive to a temp file, records its SHA-256 and runs the steps above
   with the job's abort signal: a timed-out attempt stops writing at the next step, and its
   final status write only applies while the run is still `running`, so it can never
   overwrite the failure recorded for the timeout.
4. The uploaded archive is the owner's copy, not ours to keep: it is deleted when the run
   ends. `source_storage_key` is cleared only after the deletion succeeded and a day has
   passed since the signed upload URL expired (a PUT authorized just before expiry can still
   be transferring a large archive), so an archive recreated by a replayed or late PUT is
   deleted again by the sweep. Archives that repeat a primary id in their metadata are
   refused during verification; a report says "nothing written" only for failures of that
   pre-write verification, not for a mismatch found later while storing originals. The panel retries an ambiguous start on the
   run it already uploaded to; it never creates a second run for the same file. The hourly
   `maintenance.cleanup_exports` job finishes any deletion that failed, and fails runs whose
   archive was uploaded but never started within 24 hours (`UPLOAD_INCOMPLETE`), deleting the
   archive. Such a run can no longer be started; upload again. Export and restore cleanup run
   independently, item by item, so one object that cannot be deleted never blocks the rest.
5. The report describes the attempt that completed the run. When that was a retry, it says
   so (`attempt`, and a `RETRIED_RUN` warning): what an interrupted earlier attempt wrote is
   in place but counted as skipped or reused (`skip_existing`), or as reused originals and
   copied rows (`copy`).

### CLI

```bash
pnpm backup:restore ./knowledge-vault-export-….zip --workspace <slug> [--mode skip_existing|copy]
# production image: node dist/backup-restore.mjs …
```

### Clean-environment recovery runbook (Scenario C)

1. Provision an empty Postgres and an empty bucket (or local storage).
2. Set the env vars and run `pnpm db:migrate`.
3. Run `pnpm admin:create`, which creates the admin and their workspace.
4. Run `pnpm backup:restore <archive> --workspace <slug>`.
5. Start `web` and `worker`, and wait for the re-extraction jobs (visible in Import & Backup).
6. Run the integrity check (Import & Backup → 立即檢查, or `POST /api/integrity-checks`) and confirm every file asset is `stored`
   and verified.

## 7. Integrity checks

Job `integrity.check` (manual via `POST /api/integrity-checks`, plus a weekly
`maintenance.schedule_integrity_checks` run that queues one check per workspace):

- Re-hash every `file_assets` object.
- Update `storage_status` and `integrity_verified_at`.
- Write an `integrity_checks` row with counts and the failing IDs.
- The "last successful integrity check" timestamp appears on the Import & Backup page.

## 8. Verification

The automated test (`backup-roundtrip`) runs these steps:

1. Seed a workspace through the real import pipeline: HTML, ZIP site, PDF, Markdown, image,
   and a two-version artifact.
2. Export.
3. Restore into a fresh database schema and a fresh storage root.
4. Assert:
   - identical originals (bytes and hash)
   - identical artifact, version and project metadata and relationships
   - re-extraction succeeds
5. Restore again with `skip_existing` (idempotent: nothing duplicated) and with `copy` (new
   IDs, same content).
6. Tamper test: a modified original in the archive must abort the restore with
   `CHECKSUM_MISMATCH`.
