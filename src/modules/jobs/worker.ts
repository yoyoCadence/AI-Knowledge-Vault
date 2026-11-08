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
  /** While active, polls back off from `pollIntervalMs` up to this. Default 5 s. */
  maxIdlePollIntervalMs?: number;
  /**
   * Once nothing has happened for `activeWindowMs`, the worker polls only this often, so a
   * database that scales to zero can sleep in between (ADR-024). A wake() ends the wait.
   * Default: `maxIdlePollIntervalMs` (no idle mode).
   */
  idlePollIntervalMs?: number;
  /** How long after the last job or wake the worker stays active. Default 2 minutes. */
  activeWindowMs?: number;
  /**
   * Work that runs inside the poll cycle when due (maintenance scheduling), so it shares the
   * poll's database wake-up instead of waking the database on a timer of its own. A positive
   * result counts as activity: the jobs it created are claimed right away.
   */
  periodic?: readonly { everyMs: number; run: () => Promise<number> }[];
  defaultTimeoutMs: number;
  recoveryIntervalMs?: number;
  shutdownGraceMs: number;
  workerId?: string;
}

/**
 * The wait before the worker's next poll (ADR-024).
 *
 * - A claim that left capacity polls again at once.
 * - Within `activeWindowMs` of the last job or wake, polls back off from `pollIntervalMs` to
 *   `fastMaxMs`.
 * - After that the worker polls every `idlePollIntervalMs`. A database that scales to zero
 *   after a few quiet minutes (Neon: 5) can then sleep, instead of being woken every few
 *   seconds by the worker alone.
 */
export function nextPollDelay(input: {
  claimed: number;
  canClaimMore: boolean;
  previousDelayMs: number;
  sinceActivityMs: number;
  pollIntervalMs: number;
  fastMaxMs: number;
  idlePollIntervalMs: number;
  activeWindowMs: number;
}): number {
  if (input.claimed > 0) return input.canClaimMore ? 0 : input.pollIntervalMs;
  if (input.idlePollIntervalMs > input.fastMaxMs && input.sinceActivityMs >= input.activeWindowMs) {
    return input.idlePollIntervalMs;
  }
  // Back from an idle wait (a wake), the backoff starts over.
  const previous =
    input.previousDelayMs > input.fastMaxMs ? input.pollIntervalMs : input.previousDelayMs;
  return Math.min(input.fastMaxMs, Math.round(Math.max(previous, input.pollIntervalMs) * 1.5));
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
  private lastActivityAt = Date.now();
  private readonly periodicLastRun = new Map<number, number>();

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

  /**
   * New work may be waiting (a job was enqueued): poll now, and stay active for the active
   * window. A job enqueued in a transaction that has not committed yet is found by the polls
   * that follow, so a wake may come early.
   */
  wake(): void {
    this.lastActivityAt = Date.now();
    this.wakeUp?.();
  }

  /** Runs claim/execute cycles until no runnable jobs remain. Used by tests and CLI tools. */
  async drain(): Promise<number> {
    let processed = 0;
    for (;;) {
      await this.maybeRecover();
      const claimed = await this.claim();
      if (claimed.length === 0 && this.running.size === 0) return processed;
      processed += claimed.length;
      await Promise.all([...this.running.values()].map((entry) => entry.done));
    }
  }

  private async loop(): Promise<void> {
    const fastMaxMs = this.options.maxIdlePollIntervalMs ?? 5_000;
    let delay = this.options.pollIntervalMs;
    while (!this.stopping) {
      let claimed: JobRow[] = [];
      try {
        await this.maybeRecover();
        await this.runPeriodic();
        claimed = await this.claim();
      } catch (error) {
        this.options.logger.error({ err: error }, "job claim cycle failed");
      }
      if (claimed.length > 0) this.lastActivityAt = Date.now();
      delay = nextPollDelay({
        claimed: claimed.length,
        canClaimMore: this.running.size < this.options.concurrency,
        previousDelayMs: delay,
        sinceActivityMs: Date.now() - this.lastActivityAt,
        pollIntervalMs: this.options.pollIntervalMs,
        fastMaxMs,
        idlePollIntervalMs: this.options.idlePollIntervalMs ?? fastMaxMs,
        activeWindowMs: this.options.activeWindowMs ?? 120_000,
      });
      await this.sleep(delay);
    }
  }

  private async runPeriodic(): Promise<void> {
    const tasks = this.options.periodic ?? [];
    for (const [index, task] of tasks.entries()) {
      const last = this.periodicLastRun.get(index);
      if (last !== undefined && Date.now() - last < task.everyMs) continue;
      this.periodicLastRun.set(index, Date.now());
      try {
        if ((await task.run()) > 0) this.lastActivityAt = Date.now();
      } catch (error) {
        this.options.logger.error({ err: error }, "periodic worker task failed");
      }
    }
  }

  private async maybeRecover(): Promise<void> {
    const interval = this.options.recoveryIntervalMs ?? 30_000;
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();
    const recovered = await recoverExpiredLeases(this.options.db);
    if (recovered.length === 0) return;
    const exhausted = recovered.filter((job) => job.status === "failed");
    this.options.logger.warn(
      { recovered: recovered.length, failed: exhausted.length },
      "recovered jobs with expired leases",
    );
    // Jobs that ran out of attempts never reach execute()'s failure path, so their domain
    // finalizers run here (the import maintenance job reconciles anything this misses).
    for (const job of exhausted) {
      const onFailed = this.options.registry.get(job.type)?.onFailed;
      if (!onFailed) continue;
      await onFailed({
        job,
        db: this.options.db,
        failure: { code: "LEASE_EXPIRED", message: "worker lease expired with no attempts left" },
      }).catch((error: unknown) =>
        this.options.logger.error({ err: error, jobId: job.id }, "onFailed hook threw"),
      );
    }
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
      const done = this.execute(job, controller)
        .catch((error: unknown) => {
          // Bookkeeping (e.g. failJob during a database outage) failed: the lease expires and
          // recovery re-queues the job. Never let this become an unhandled rejection.
          this.options.logger.error(
            { err: error, jobId: job.id, jobType: job.type },
            "job execution bookkeeping failed; lease recovery will retry it",
          );
        })
        .finally(() => {
          this.running.delete(job.id);
          // A job that ran longer than the active window may have enqueued follow-ups.
          this.lastActivityAt = Date.now();
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
