import { afterAll, describe, expect, it } from "vitest";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { getStorage } from "@/infrastructure/storage";
import { t, tOptional } from "@/lib/i18n";
import { completeItem, declareItem, getBatchReport, importLimitsFromEnv } from "@/modules/imports";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/**
 * The import report (FR-IMP-10) shows each failed file's reason in the UI's language, looked up
 * by the code the pipeline stored (`import.error.<code>`); the code and the server's message
 * stay as the technical detail. These failures come from different stages (content sniffing,
 * the ZIP reader, upload completion), so a code that any of them starts to store without a
 * reason fails here, instead of showing 「匯入失敗。」 in the report.
 */

const db = testDb();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

describe("import failure reasons", () => {
  it("every failure the pipeline records has a reason in zh-TW", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    await uploadFile(actor, batch.id, { filename: "broken.pdf", bytes: "not a pdf at all" });
    await uploadFile(actor, batch.id, {
      filename: "broken-archive.zip",
      bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("garbage")]),
    });
    // Declared 10 bytes, uploaded 5: completion refuses it.
    const { item } = await declareItem(
      db,
      getStorage(),
      actor,
      batch.id,
      { filename: "short.txt", size: 10 },
      importLimitsFromEnv(getEnv()),
    );
    await getStorage().putObject(item.stagingKey, Buffer.from("hello"));
    await expect(completeItem(db, getStorage(), actor, batch.id, item.id)).rejects.toMatchObject({
      code: "SIZE_MISMATCH",
    });
    await drainJobs();

    const report = await getBatchReport(db, actor, batch.id);
    const failed = report.items.filter((row) => row.status === "failed");
    expect(failed.map((row) => row.errorCode).sort()).toEqual([
      "ARCHIVE_REJECTED",
      "SIZE_MISMATCH",
      "UNSUPPORTED_FILE_TYPE",
    ]);
    for (const row of failed) {
      const reason = tOptional(`import.error.${row.errorCode}`);
      expect(reason, row.errorCode!).toEqual(expect.any(String));
      expect(reason).not.toBe(t("import.error.unknown"));
      // A reason a reader can understand, not the code again.
      expect(reason).not.toContain(row.errorCode!);
    }
  });
});
