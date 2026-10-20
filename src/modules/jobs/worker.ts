import { hostname } from "node:os";
import type { Database } from "@/infrastructure/database/client";
import type { Logger } from "@/infrastructure/observability/logger";
import type { StorageAdapter } from "@/infrastructure/storage";
import { isAppError } from "@/lib/errors";
import { newErrorId, newId } from "@/lib/ids";
import {
  claimJobs,
  completeJob,
  failJob,
  heartbeatJob,
  recoverExpiredLeases,
  type JobFailure,
  type JobRow,
} from "./queue";
import type { JobRegistry } from "./registry";

export interface JobWorkerOptions {
  db: Database;
  storage: StorageAdapter;
  logger: Logger;
  registry: JobRegistry;
  concurrency: number;
  leaseSeconds: number;
  pollIntervalMs: number;
  maxIdlePollIntervalMs?: number;
  defaultTimeoutMs: number;
  recoveryIntervalMs?: number;
  shutdownGraceMs: number;
  workerId?: string;
}

/** Thrown into a handler's AbortSignal when its lease is lost to recovery. */
class LeaseLostError extends Error {
  constructor() {
    super("job lease lost");
    this.name = "LeaseLostError";
  }
}

class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`job exceeded timeout of ${timeoutMs} ms`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Long-running worker loop (ADR-005): bounded concurrency, lease heartbeats, timeouts,
 * periodic lease recovery, graceful shutdown. One instance per worker process.
 */
export class JobWorker {
  readonly workerId: string;
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;
  private lastRecoveryAt = 0;

  constructor(private readonly options: JobWorkerOptions) {
    this.workerId = options.workerId ?? `${hostname()}:${process.pid}:${newId().slice(-8)}`;
  }

  start(): void {
    if (this.loopPromise) return;
    this.options.logger.info(
      { workerId: this.workerId, types: this.options.registry.types() },
      "job worker started",
    );
    this.loopPromise = this.loop();
  }

  /** Stops claiming, waits for in-flight jobs up to the grace period, then aborts the rest. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeUp?.();
    await this.loopPromise;
    const inFlight = [...this.running.values()];
    const grace = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), this.options.shutdownGraceMs),
    );
    const outcome = await Promise.race([Promise.all(inFlight.map((entry) => entry.done)), grace]);
    if (outcome === "timeout") {
      for (const entry of this.running.values())
        entry.controller.abort(new Error("worker shutting down"));
      await Promise.allSettled(inFlight.map((entry) => entry.done));
    }
    this.options.logger.info({ workerId: this.workerId }, "job worker stopped");
  }

  /** Runs claim/execute cycles until no runnable jobs remain. Used by tests and CLI tools. */
  async drain(): Promise<number> {
    let processed = 0;
    for (;;) {
      const claimed = await this.claim();
      if (claimed.length === 0 && this.running.size === 0) return processed;
      processed += claimed.length;
      await Promise.all([...this.running.values()].map((entry) => entry.done));
    }
  }

  private async loop(): Promise<void> {
    let idleDelay = this.options.pollIntervalMs;
    const maxIdle = this.options.maxIdlePollIntervalMs ?? 5_000;
    while (!this.stopping) {
      let claimed: JobRow[] = [];
      try {
        await this.maybeRecover();
        claimed = await this.claim();
      } catch (error) {
        this.options.logger.error({ err: error }, "job claim cycle failed");
      }
      idleDelay =
        claimed.length > 0
          ? this.options.pollIntervalMs
          : Math.min(maxIdle, Math.round(idleDelay * 1.5));
      await this.sleep(
        claimed.length > 0 && this.running.size < this.options.concurrency ? 0 : idleDelay,
      );
    }
  }

  private async maybeRecover(): Promise<void> {
    const interval = this.options.recoveryIntervalMs ?? 30_000;
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();
    const recovered = await recoverExpiredLeases(this.options.db);
    if (recovered > 0)
      this.options.logger.warn({ recovered }, "recovered jobs with expired leases");
  }

  private async claim(): Promise<JobRow[]> {
    const capacity = this.options.concurrency - this.running.size;
    const types = this.options.registry.types();
    if (capacity <= 0 || types.length === 0) return [];
    const jobs = await claimJobs(this.options.db, {
      workerId: this.workerId,
      limit: capacity,
      leaseSeconds: this.options.leaseSeconds,
      types,
    });
    for (const job of jobs) {
      const controller = new AbortController();
      const done = this.execute(job, controller).finally(() => {
        this.running.delete(job.id);
        this.wakeUp?.();
      });
      this.running.set(job.id, { controller, done });
    }
    return jobs;
  }

  private async execute(job: JobRow, controller: AbortController): Promise<void> {
    const { db, logger: baseLogger, leaseSeconds } = this.options;
    const logger = baseLogger.child({
      jobId: job.id,
      jobType: job.type,
      attempt: job.attemptCount,
    });
    const definition = this.options.registry.get(job.type);
    if (!definition) {
      await failJob(db, job, this.workerId, {
        code: "UNKNOWN_JOB_TYPE",
        message: `no handler registered for ${job.type}`,
        retryable: false,
      });
      return;
    }

    const timeoutMs = definition.timeoutMs ?? this.options.defaultTimeoutMs;
    const timeout = setTimeout(() => controller.abort(new JobTimeoutError(timeoutMs)), timeoutMs);
    const heartbeat = setInterval(
      () => {
        heartbeatJob(db, job.id, this.workerId, leaseSeconds)
          .then((owned) => {
            if (!owned) controller.abort(new LeaseLostError());
          })
          .catch((error: unknown) => logger.warn({ err: error }, "heartbeat failed"));
      },
      Math.max(1_000, (leaseSeconds * 1000) / 3),
    );

    const startedAt = Date.now();
    try {
      const result = await abortable(
        definition.handler({
          job,
          db,
          storage: this.options.storage,
          logger,
          signal: controller.signal,
          reportProgress: async (progress) => {
            const owned = await heartbeatJob(db, job.id, this.workerId, leaseSeconds, progress);
            if (!owned) controller.abort(new LeaseLostError());
          },
        }),
        controller.signal,
      );
      const completed = await completeJob(db, job.id, this.workerId, result ?? undefined);
      logger.info({ durationMs: Date.now() - startedAt, completed }, "job completed");
    } catch (error) {
      if (controller.signal.reason instanceof LeaseLostError) {
        logger.warn("job lease lost; abandoning without completion");
        return;
      }
      const failure = toFailure(error, controller.signal.reason);
      const errorId = newErrorId();
      const outcome = await failJob(db, job, this.workerId, failure);
      if (outcome === "failed" && definition.onFailed) {
        await definition
          .onFailed({ job, db, failure: { code: failure.code, message: failure.message } })
          .catch((hookError: unknown) => logger.error({ err: hookError }, "onFailed hook threw"));
      }
      logger[outcome === "failed" ? "error" : "warn"](
        { err: error, errorId, code: failure.code, outcome, durationMs: Date.now() - startedAt },
        "job attempt failed",
      );
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = undefined;
        resolve();
      }, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
    });
  }
}

/** Rejects as soon as the signal aborts, even if the handler ignores it. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function toFailure(error: unknown, abortReason: unknown): JobFailure {
  if (abortReason instanceof JobTimeoutError) {
    return { code: "PROCESSING_TIMEOUT", message: abortReason.message, retryable: false };
  }
  if (isAppError(error)) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  // Unknown errors are treated as transient (network, storage hiccups) and retried with backoff.
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "unknown error",
    retryable: true,
  };
}
