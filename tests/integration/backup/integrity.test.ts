import { writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GET as latestRoute } from "@/app/api/integrity-checks/latest/route";
import { POST as requestRoute } from "@/app/api/integrity-checks/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { fileAssets, integrityChecks } from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";
import { requestIntegrityCheck } from "@/modules/backup";
import { htmlDocument, markdownDocument, pngImage } from "@tests/fixtures/builders";
import { createTestAdmin, signIn } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
function apiRequest(urlPath: string, init: { method?: string; cookie: string }) {
  const origin = getEnv().APP_ORIGIN;
  return new Request(`${origin}${urlPath}`, {
    method: init.method ?? "GET",
    headers: { origin, cookie: init.cookie, "content-type": "application/json" },
    body: init.method === "POST" ? "{}" : undefined,
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

type CheckDto = {
  id: string;
  status: string;
  checkedCount: number;
  okCount: number;
  missingCount: number;
  corruptCount: number;
  failures: { fileAssetId: string; status: string }[];
};

describe("integrity check (BACKUP_RECOVERY §7)", () => {
  it("verifies every original, then detects missing and corrupt objects", async () => {
    const { cookie, actor } = await owner();
    const batch = await newBatch(actor);
    for (const file of [
      {
        filename: "integrity-a.html",
        bytes: htmlDocument({ title: `完整性 ${actor.workspaceId}` }),
      },
      { filename: "integrity-b.md", bytes: `${markdownDocument()}\n${actor.workspaceId}\n` },
      { filename: "integrity-c.png", bytes: await pngImage(64, 48, { r: 9, g: 99, b: 199 }) },
    ]) {
      await uploadFile(actor, batch.id, file);
    }
    await drainJobs();

    const requested = await requestRoute(
      apiRequest("/api/integrity-checks", { method: "POST", cookie }),
      params({}),
    );
    expect(requested.status).toBe(202);
    const { check: first } = (await requested.json()) as { check: CheckDto };
    // A second request while one is pending returns the same check.
    expect((await requestIntegrityCheck(db, actor.workspaceId)).id).toBe(first.id);
    await drainJobs();
    const latest = async () =>
      (
        (await (
          await latestRoute(apiRequest("/api/integrity-checks/latest", { cookie }), params({}))
        ).json()) as {
          check: CheckDto;
        }
      ).check;
    expect(await latest()).toMatchObject({
      id: first.id,
      status: "completed",
      checkedCount: 3,
      okCount: 3,
      missingCount: 0,
      corruptCount: 0,
    });
    const assets = await db
      .select()
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, actor.workspaceId));
    expect(assets.every((asset) => asset.integrityVerifiedAt !== null)).toBe(true);

    // Damage storage behind the app's back: delete one object, overwrite another on disk.
    const [gone, rotten] = assets;
    await getStorage().deleteObject(gone!.storageKey);
    await writeFile(
      path.join(getEnv().LOCAL_STORAGE_DIR, "objects", rotten!.storageKey),
      "bit rot",
    );

    await requestIntegrityCheck(db, actor.workspaceId);
    await drainJobs();
    const second = await latest();
    expect(second).toMatchObject({
      status: "completed",
      okCount: 1,
      missingCount: 1,
      corruptCount: 1,
    });
    expect(second.failures.map((failure) => [failure.fileAssetId, failure.status]).sort()).toEqual(
      [
        [gone!.id, "missing"],
        [rotten!.id, "corrupt"],
      ].sort(),
    );
    const [goneRow] = await db.select().from(fileAssets).where(eq(fileAssets.id, gone!.id));
    const [rottenRow] = await db.select().from(fileAssets).where(eq(fileAssets.id, rotten!.id));
    expect(goneRow?.storageStatus).toBe("missing");
    expect(rottenRow?.storageStatus).toBe("corrupt");

    // Another workspace sees nothing.
    const stranger = await owner();
    const theirs = (await (
      await latestRoute(
        apiRequest("/api/integrity-checks/latest", { cookie: stranger.cookie }),
        params({}),
      )
    ).json()) as { check: CheckDto | null };
    expect(theirs.check).toBeNull();
    expect(
      (
        await db
          .select()
          .from(integrityChecks)
          .where(eq(integrityChecks.workspaceId, actor.workspaceId))
      ).length,
    ).toBe(2);
  });
});
