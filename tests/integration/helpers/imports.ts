import { getEnv } from "@/infrastructure/config/env";
import { getLogger } from "@/infrastructure/observability/logger";
import { getStorage, type StorageAdapter } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";
import type { Actor } from "@/modules/auth";
import { completeItem, createBatch, declareItem, importLimitsFromEnv } from "@/modules/imports";
import { JobWorker, type JobRegistry } from "@/modules/jobs";
import { buildJobRegistry } from "@/worker/registry";
import { createTestAdmin } from "./auth";
import { testDb } from "./db";

/** An owner actor with its own fresh workspace (no session needed for service-level tests). */
export async function createTestActor(): Promise<Actor> {
  const admin = await createTestAdmin();
  return {
    userId: admin.userId,
    workspaceId: admin.workspaceId,
    role: "owner",
    sessionId: newId(),
    email: admin.email,
    name: "Test Admin",
  };
}

export async function newBatch(actor: Actor, options: Parameters<typeof createBatch>[2] = {}) {
  return createBatch(testDb(), actor, options);
}

/** Declares a file, uploads its bytes to staging (as a browser PUT would) and completes it. */
export async function uploadFile(
  actor: Actor,
  batchId: string,
  file: { filename: string; bytes: Buffer | string; targetArtifactId?: string; clientKey?: string },
  storage: StorageAdapter = getStorage(),
) {
  const bytes = typeof file.bytes === "string" ? Buffer.from(file.bytes) : file.bytes;
  const { item } = await declareItem(
    testDb(),
    storage,
    actor,
    batchId,
    {
      filename: file.filename,
      size: bytes.length,
      targetArtifactId: file.targetArtifactId,
      clientKey: file.clientKey,
    },
    importLimitsFromEnv(getEnv()),
  );
  await storage.putObject(item.stagingKey, bytes);
  return completeItem(testDb(), storage, actor, batchId, item.id);
}

export function testWorker(
  options: { storage?: StorageAdapter; registry?: JobRegistry; concurrency?: number } = {},
) {
  return new JobWorker({
    db: testDb(),
    storage: options.storage ?? getStorage(),
    logger: getLogger({ test: "worker" }),
    registry: options.registry ?? buildJobRegistry(getEnv()),
    concurrency: options.concurrency ?? 3,
    leaseSeconds: 60,
    pollIntervalMs: 10,
    defaultTimeoutMs: 60_000,
    shutdownGraceMs: 1_000,
  });
}

/** Runs every runnable job to completion. */
export function drainJobs(options?: Parameters<typeof testWorker>[0]) {
  return testWorker(options).drain();
}
