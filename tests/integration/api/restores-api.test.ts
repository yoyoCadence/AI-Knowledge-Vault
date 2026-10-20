import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getRestoreRoute } from "@/app/api/restores/[id]/route";
import { POST as startRoute } from "@/app/api/restores/[id]/start/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/restores/route";
import { PUT as localUpload } from "@/app/api/storage/local/upload/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, auditLogs, restoreRuns } from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";
import { restoreLimitsFromEnv, writeExport } from "@/modules/backup";
import { SafeZip } from "@/modules/extraction";
import { htmlDocument } from "@tests/fixtures/builders";
import { buildZip, type ZipEntrySpec } from "@tests/fixtures/zip";
import { createTestAdmin, signIn } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-restore-api-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await closeDb();
  await closeTestDb();
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
function apiRequest(urlPath: string, init: { method?: string; cookie: string; body?: unknown }) {
  const origin = getEnv().APP_ORIGIN;
  return new Request(`${origin}${urlPath}`, {
    method: init.method ?? "GET",
    headers: { origin, cookie: init.cookie, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function owner() {
  const admin = await createTestAdmin();
  const { cookie } = await signIn(admin.email, admin.password);
  const actor = {
    userId: admin.userId,
    workspaceId: admin.workspaceId,
    role: "owner" as const,
    sessionId: newId(),
    email: admin.email,
    name: "Owner",
  };
  return { cookie, actor };
}

type RestoreDto = {
  id: string;
  status: string;
  started: boolean;
  errorCode: string | null;
  report: {
    counts?: { artifacts: Record<string, number> };
    details?: { files?: string[] };
  } | null;
};

async function uploadArchive(cookie: string, bytes: Buffer, filename = "backup.zip") {
  const created = await createRoute(
    apiRequest("/api/restores", { method: "POST", cookie, body: { filename, size: bytes.length } }),
    params({}),
  );
  expect(created.status).toBe(201);
  const { restore, upload } = (await created.json()) as {
    restore: RestoreDto;
    upload: { url: string };
  };
  const put = await localUpload(
    new Request(upload.url, {
      method: "PUT",
      body: new Uint8Array(bytes),
      headers: { "content-length": String(bytes.length) },
    }),
  );
  expect(put.status).toBe(200);
  return restore;
}

const start = (cookie: string, id: string, mode = "skip_existing") =>
  startRoute(
    apiRequest(`/api/restores/${id}/start`, { method: "POST", cookie, body: { mode } }),
    params({ id }),
  );
const read = async (cookie: string, id: string) =>
  (
    (await (
      await getRestoreRoute(apiRequest(`/api/restores/${id}`, { cookie }), params({ id }))
    ).json()) as { restore: RestoreDto }
  ).restore;

describe("restore over HTTP (BACKUP_RECOVERY §6)", () => {
  let archive: Buffer;

  beforeAll(async () => {
    const source = await owner();
    await uploadFile(source.actor, (await newBatch(source.actor)).id, {
      filename: "restore-api.html",
      bytes: htmlDocument({ title: `還原 API ${source.actor.workspaceId}` }),
    });
    await drainJobs();
    const file = path.join(dir, "source.zip");
    await writeExport(db, getStorage(), source.actor.workspaceId, createWriteStream(file));
    archive = await readFile(file);
  });

  it("uploads, verifies and restores an export; the upload is removed afterwards", async () => {
    const { cookie, actor } = await owner();
    const restore = await uploadArchive(cookie, archive);
    expect(restore).toMatchObject({ status: "queued", started: false });

    const started = await start(cookie, restore.id);
    expect(started.status).toBe(202);
    expect((await start(cookie, restore.id)).status).toBe(202); // idempotent
    await drainJobs();

    const done = await read(cookie, restore.id);
    expect(done.status).toBe("completed");
    // The source workspace still owns the archived ids, so they are restored under new ids.
    expect(done.report?.counts?.artifacts).toMatchObject({ copied: 1, failed: 0 });
    expect(
      (await db.select().from(artifacts).where(eq(artifacts.workspaceId, actor.workspaceId)))
        .length,
    ).toBe(1);
    const [run] = await db.select().from(restoreRuns).where(eq(restoreRuns.id, restore.id));
    expect(run?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await getStorage().headObject(run!.sourceStorageKey!)).toBeNull();
    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, restore.id));
    expect(audits.map((row) => row.action).sort()).toEqual([
      "backup.restore.requested",
      "backup.restore.started",
    ]);
    const { items } = (await (
      await listRoute(apiRequest("/api/restores", { cookie }), params({}))
    ).json()) as { items: RestoreDto[] };
    expect(items.map((item) => item.id)).toEqual([restore.id]);
  });

  it("a tampered archive fails with CHECKSUM_MISMATCH and writes nothing", async () => {
    const { cookie, actor } = await owner();
    // Re-pack the export with one byte of an original flipped (checksums left as they were).
    const source = path.join(dir, "to-tamper.zip");
    await writeFile(source, archive);
    const zip = await SafeZip.open(source, restoreLimitsFromEnv(getEnv()));
    const entries: ZipEntrySpec[] = [];
    for (const entry of zip.inventory.entries) {
      if (entry.isDirectory) continue;
      const data = await zip.readBuffer(entry.path, 64 * 1024 * 1024);
      if (entry.path.startsWith("originals/")) data.writeUInt8(data.readUInt8(0) ^ 0xff, 0);
      entries.push({ name: entry.path, data });
    }
    zip.close();
    const restore = await uploadArchive(cookie, buildZip(entries));
    await start(cookie, restore.id);
    await drainJobs();
    const failed = await read(cookie, restore.id);
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.errorCode).toBe("CHECKSUM_MISMATCH");
    expect(failed.report?.details?.files?.[0]).toMatch(/^originals\//);
    expect(
      (await db.select().from(artifacts).where(eq(artifacts.workspaceId, actor.workspaceId)))
        .length,
    ).toBe(0);
  });

  it("refuses to start before the upload, oversize declarations, and other workspaces", async () => {
    const { cookie } = await owner();
    const created = await createRoute(
      apiRequest("/api/restores", {
        method: "POST",
        cookie,
        body: { filename: "later.zip", size: 1234 },
      }),
      params({}),
    );
    const { restore } = (await created.json()) as { restore: RestoreDto };
    expect((await start(cookie, restore.id)).status).toBe(409); // UPLOAD_INCOMPLETE

    const tooBig = await createRoute(
      apiRequest("/api/restores", {
        method: "POST",
        cookie,
        body: { filename: "huge.zip", size: getEnv().RESTORE_MAX_ARCHIVE_BYTES + 1 },
      }),
      params({}),
    );
    expect(tooBig.status).toBe(413);

    const stranger = await owner();
    const response = await getRestoreRoute(
      apiRequest(`/api/restores/${restore.id}`, { cookie: stranger.cookie }),
      params({ id: restore.id }),
    );
    expect(response.status).toBe(404);
  });
});
