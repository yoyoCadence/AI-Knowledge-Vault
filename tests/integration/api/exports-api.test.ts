import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GET as downloadRoute } from "@/app/api/exports/[id]/download/route";
import { GET as listRoute, POST as requestRoute } from "@/app/api/exports/route";
import { GET as localDownload } from "@/app/api/storage/local/download/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { auditLogs, exportRuns } from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";
import { deleteExpiredExports } from "@/modules/backup";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signIn } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

function apiRequest(path: string, init: { method?: string; cookie?: string } = {}) {
  const origin = getEnv().APP_ORIGIN;
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.method === "POST" ? "{}" : undefined,
  });
}

async function loggedIn() {
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
  return { ...admin, cookie, actor };
}

type ExportDto = {
  id: string;
  status: string;
  sha256: string | null;
  byteSize: number | null;
  downloadable: boolean;
  summary: { counts: { artifacts: number } } | null;
};

describe("export API (BACKUP_RECOVERY §3)", () => {
  it("queues an export, builds it in the worker and serves an audited, verifiable download", async () => {
    const owner = await loggedIn();
    await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
      filename: "export-api.html",
      bytes: htmlDocument({ title: `匯出 API ${owner.workspaceId}` }),
    });
    await drainJobs();

    const requested = await requestRoute(
      apiRequest("/api/exports", { method: "POST", cookie: owner.cookie }),
      params({}),
    );
    expect(requested.status).toBe(202);
    const { export: queued } = (await requested.json()) as { export: ExportDto };
    expect(queued).toMatchObject({ status: "queued", downloadable: false });

    // Not downloadable before it is built.
    expect(
      (
        await downloadRoute(
          apiRequest(`/api/exports/${queued.id}/download`, { cookie: owner.cookie }),
          params({ id: queued.id }),
        )
      ).status,
    ).toBe(409);

    await drainJobs();
    const { items } = (await (
      await listRoute(apiRequest("/api/exports", { cookie: owner.cookie }), params({}))
    ).json()) as { items: ExportDto[] };
    const built = items.find((item) => item.id === queued.id)!;
    expect(built).toMatchObject({ status: "completed", downloadable: true });
    expect(built.summary?.counts.artifacts).toBe(1);

    const redirect = await downloadRoute(
      apiRequest(`/api/exports/${queued.id}/download`, { cookie: owner.cookie }),
      params({ id: queued.id }),
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("x-content-sha256")).toBe(built.sha256);
    const file = await localDownload(new Request(redirect.headers.get("location")!));
    expect(file.status).toBe(200);
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.length).toBe(built.byteSize);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(built.sha256);
    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, queued.id));
    expect(audits.map((row) => row.action).sort()).toEqual([
      "backup.export.downloaded",
      "backup.export.requested",
    ]);

    // Another workspace cannot see or download it.
    const stranger = await loggedIn();
    expect(
      (
        await downloadRoute(
          apiRequest(`/api/exports/${queued.id}/download`, { cookie: stranger.cookie }),
          params({ id: queued.id }),
        )
      ).status,
    ).toBe(404);
    const theirs = (await (
      await listRoute(apiRequest("/api/exports", { cookie: stranger.cookie }), params({}))
    ).json()) as { items: ExportDto[] };
    expect(theirs.items).toEqual([]);

    // Expiry: maintenance deletes the archive and the run stops being downloadable.
    await db
      .update(exportRuns)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(exportRuns.id, queued.id));
    const [run] = await db.select().from(exportRuns).where(eq(exportRuns.id, queued.id));
    expect(await deleteExpiredExports(db, getStorage())).toBeGreaterThanOrEqual(1);
    expect(await getStorage().headObject(run!.storageKey!)).toBeNull();
    expect(
      (
        await downloadRoute(
          apiRequest(`/api/exports/${queued.id}/download`, { cookie: owner.cookie }),
          params({ id: queued.id }),
        )
      ).status,
    ).toBe(409);
  });
});
