import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { processingJobs } from "@/infrastructure/database/schema";
import { getLogger } from "@/infrastructure/observability/logger";
import { LocalStorageAdapter } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  heartbeatJob,
  JobRegistry,
  JobWorker,
  recoverExpiredLeases,
  retryJob,
} from "@/modules/jobs";
import { closeTestDb, testDb, truncate } from "../helpers/db";

const db = testDb();

beforeEach(async () => {
  await truncate(db, "processing_jobs");
});

afterAll(async () => {
  await closeTestDb();
});

async function getJob(id: string) {
  const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, id));
  return row!;
}

describe("job queue", () => {
  it("enqueue is idempotent on idempotency_key", async () => {
    const first = await enqueueJob(db, { type: "t", idempotencyKey: "k1", payload: { a: 1 } });
    const second = await enqueueJob(db, { type: "t", idempotencyKey: "k1", payload: { a: 2 } });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.payload).toEqual({ a: 1 });
  });

  it("enqueue participates in the caller's transaction (rollback leaves no job)", async () => {
    await expect(
      db.transaction(async (tx) => {
        await enqueueJob(tx, { type: "t", idempotencyKey: "tx-1" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const rows = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.idempotencyKey, "tx-1"));
    expect(rows).toHaveLength(0);
  });

  it("concurrent claimers never claim the same job (SKIP LOCKED)", async () => {
    for (let index = 0; index < 20; index += 1) {
      await enqueueJob(db, { type: "t", idempotencyKey: `c-${index}` });
    }
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        claimJobs(db, { workerId: `w${index}`, limit: 6, leaseSeconds: 60 }),
      ),
    );
    const ids = claims.flat().map((job) => job.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("claims by priority and respects run_after and type filters", async () => {
    await enqueueJob(db, { type: "a", idempotencyKey: "low", priority: 0 });
    await enqueueJob(db, { type: "a", idempotencyKey: "high", priority: 10 });
    await enqueueJob(db, {
      type: "a",
      idempotencyKey: "later",
      priority: 100,
      runAfter: new Date(Date.now() + 60_000),
    });
    await enqueueJob(db, { type: "b", idempotencyKey: "other-type", priority: 50 });

    const [first] = await claimJobs(db, {
      workerId: "w",
      limit: 1,
      leaseSeconds: 60,
      types: ["a"],
    });
    expect(first?.idempotencyKey).toBe("high");
    expect(first?.status).toBe("running");
    expect(first?.attemptCount).toBe(1);

    const rest = await claimJobs(db, { workerId: "w", limit: 10, leaseSeconds: 60, types: ["a"] });
    expect(rest.map((job) => job.idempotencyKey)).toEqual(["low"]);
  });

  it("only the lease owner can heartbeat or complete", async () => {
    const { job } = await enqueueJob(db, { type: "t", idempotencyKey: "own" });
    await claimJobs(db, { workerId: "owner", limit: 1, leaseSeconds: 60 });
    expect(await heartbeatJob(db, job.id, "intruder", 60)).toBe(false);
    expect(await completeJob(db, job.id, "intruder")).toBe(false);
    expect(await heartbeatJob(db, job.id, "owner", 60, { current: 1, total: 2 })).toBe(true);
    expect(await completeJob(db, job.id, "owner", { ok: true })).toBe(true);
    const done = await getJob(job.id);
    expect(done).toMatchObject({
      status: "completed",
      result: { ok: true },
      lockedBy: null,
      progress: { current: 1, total: 2 },
    });
  });

  it("retryable failures re-queue with backoff until attempts are exhausted", async () => {
    const { job } = await enqueueJob(db, { type: "t", idempotencyKey: "retry", maxAttempts: 2 });
    let [claimed] = await claimJobs(db, { workerId: "w", limit: 1, leaseSeconds: 60 });
    expect(await failJob(db, claimed!, "w", { code: "X", message: "boom", retryable: true })).toBe(
      "requeued",
    );
    let row = await getJob(job.id);
    expect(row.status).toBe("queued");
    expect(row.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastError).toBe("boom");

    await db
      .update(processingJobs)
      .set({ runAfter: sql`now()` })
      .where(eq(processingJobs.id, job.id));
    [claimed] = await claimJobs(db, { workerId: "w", limit: 1, leaseSeconds: 60 });
    expect(claimed?.attemptCount).toBe(2);
    expect(
      await failJob(db, claimed!, "w", { code: "X", message: "boom again", retryable: true }),
    ).toBe("failed");
    row = await getJob(job.id);
    expect(row).toMatchObject({ status: "failed", errorCode: "X" });
    expect(row.completedAt).not.toBeNull();

    const retried = await retryJob(db, job.id);
    expect(retried).toMatchObject({ status: "queued", attemptCount: 0, lastError: null });
  });

  it("permanent failures fail immediately", async () => {
    const { job } = await enqueueJob(db, { type: "t", idempotencyKey: "perm" });
    const [claimed] = await claimJobs(db, { workerId: "w", limit: 1, leaseSeconds: 60 });
    expect(await failJob(db, claimed!, "w", { code: "BAD", message: "no", retryable: false })).toBe(
      "failed",
    );
    expect((await getJob(job.id)).status).toBe("failed");
  });

  it("recovers expired leases: re-queues when attempts remain, fails when exhausted", async () => {
    const a = await enqueueJob(db, { type: "t", idempotencyKey: "lease-a", maxAttempts: 3 });
    const b = await enqueueJob(db, { type: "t", idempotencyKey: "lease-b", maxAttempts: 1 });
    await claimJobs(db, { workerId: "crashed", limit: 2, leaseSeconds: 60 });
    await db.update(processingJobs).set({ lockedUntil: sql`now() - interval '1 second'` });

    expect(await recoverExpiredLeases(db)).toBe(2);
    expect(await getJob(a.job.id)).toMatchObject({
      status: "queued",
      lockedBy: null,
      errorCode: "LEASE_EXPIRED",
    });
    expect(await getJob(b.job.id)).toMatchObject({ status: "failed", errorCode: "LEASE_EXPIRED" });

    // The crashed worker can no longer complete the recovered job.
    expect(await completeJob(db, a.job.id, "crashed")).toBe(false);
  });
});

describe("JobWorker", () => {
  const storage = new LocalStorageAdapter("/tmp/vault-unused", {
    signingSecret: "s".repeat(48),
    publicBaseUrl: "http://x",
  });

  function makeWorker(
    registry: JobRegistry,
    overrides: Partial<ConstructorParameters<typeof JobWorker>[0]> = {},
  ) {
    return new JobWorker({
      db,
      storage,
      logger: getLogger({ test: true }),
      registry,
      concurrency: 3,
      leaseSeconds: 30,
      pollIntervalMs: 10,
      defaultTimeoutMs: 5_000,
      shutdownGraceMs: 1_000,
      workerId: "test-worker",
      ...overrides,
    });
  }

  it("executes registered handlers with bounded concurrency and records results", async () => {
    let active = 0;
    let peak = 0;
    const registry = new JobRegistry().register({
      type: "test.sleep",
      handler: async ({ job, reportProgress }) => {
        active += 1;
        peak = Math.max(peak, active);
        await reportProgress({ current: 1, total: 1 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { echo: job.payload.n };
      },
    });
    for (let n = 0; n < 7; n += 1)
      await enqueueJob(db, { type: "test.sleep", idempotencyKey: `s-${n}`, payload: { n } });

    const processed = await makeWorker(registry).drain();
    expect(processed).toBe(7);
    expect(peak).toBeLessThanOrEqual(3);
    const rows = await db.select().from(processingJobs);
    expect(rows.every((row) => row.status === "completed")).toBe(true);
    expect(rows.map((row) => row.result?.echo).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("retries transient errors and stops on permanent AppErrors", async () => {
    let calls = 0;
    const registry = new JobRegistry()
      .register({
        type: "test.flaky",
        handler: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient");
          return { calls };
        },
      })
      .register({
        type: "test.invalid",
        handler: async () => {
          throw new AppError("UNSUPPORTED_FILE_TYPE", "nope");
        },
      });
    const flaky = await enqueueJob(db, { type: "test.flaky", idempotencyKey: "flaky" });
    const invalid = await enqueueJob(db, { type: "test.invalid", idempotencyKey: "invalid" });
    const worker = makeWorker(registry);

    await worker.drain();
    expect((await getJob(flaky.job.id)).status).toBe("queued"); // backoff scheduled
    expect(await getJob(invalid.job.id)).toMatchObject({
      status: "failed",
      errorCode: "UNSUPPORTED_FILE_TYPE",
      attemptCount: 1,
    });

    await db
      .update(processingJobs)
      .set({ runAfter: sql`now()` })
      .where(eq(processingJobs.id, flaky.job.id));
    await worker.drain();
    expect(await getJob(flaky.job.id)).toMatchObject({
      status: "completed",
      attemptCount: 2,
      result: { calls: 2 },
    });
  });

  it("fails timed-out jobs with PROCESSING_TIMEOUT", async () => {
    const registry = new JobRegistry().register({
      type: "test.hang",
      timeoutMs: 50,
      handler: () => new Promise(() => {}),
    });
    const { job } = await enqueueJob(db, { type: "test.hang", idempotencyKey: "hang" });
    await makeWorker(registry).drain();
    expect(await getJob(job.id)).toMatchObject({
      status: "failed",
      errorCode: "PROCESSING_TIMEOUT",
    });
  });

  it("does not claim job types it has no handler for", async () => {
    const registry = new JobRegistry().register({ type: "test.known", handler: async () => {} });
    const unknown = await enqueueJob(db, { type: "test.unknown", idempotencyKey: "unknown" });
    await makeWorker(registry).drain();
    expect((await getJob(unknown.job.id)).status).toBe("queued");
  });

  it("start/stop runs the polling loop and shuts down gracefully", async () => {
    const seen: number[] = [];
    const registry = new JobRegistry().register({
      type: "test.loop",
      handler: async ({ job }) => {
        seen.push(job.payload.n as number);
      },
    });
    const worker = makeWorker(registry);
    worker.start();
    for (let n = 0; n < 3; n += 1)
      await enqueueJob(db, { type: "test.loop", idempotencyKey: `loop-${n}`, payload: { n } });
    const deadline = Date.now() + 5_000;
    while (seen.length < 3 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.stop();
    expect(seen.sort()).toEqual([0, 1, 2]);
  });
});
