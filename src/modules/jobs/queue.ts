import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import { processingJobs, type JobProgress } from "@/infrastructure/database/schema";

/**
 * PostgreSQL-backed durable job queue (ADR-005).
 *
 * Guarantees:
 * - At-least-once execution. Handlers MUST be idempotent.
 * - A job is owned by at most one worker at a time (row lock during claim + lease).
 * - A crashed worker's jobs are recovered after `locked_until` passes.
 * - `idempotency_key` is unique: enqueueing the same logical job twice is a no-op.
 */

export type JobRow = typeof processingJobs.$inferSelect;

export interface EnqueueInput {
  type: string;
  idempotencyKey: string;
  workspaceId?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
}

/** Inserts a job unless one with the same idempotency key exists. Safe inside a transaction. */
export async function enqueueJob(
  db: DbExecutor,
  input: EnqueueInput,
): Promise<{ job: JobRow; created: boolean }> {
  const inserted = await db
    .insert(processingJobs)
    .values({
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      workspaceId: input.workspaceId ?? null,
      payload: input.payload ?? {},
      priority: input.priority ?? 0,
      runAfter: input.runAfter ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: processingJobs.idempotencyKey })
    .returning();
  if (inserted[0]) return { job: inserted[0], created: true };

  const [existing] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.idempotencyKey, input.idempotencyKey));
  if (!existing) throw new Error("job vanished between insert conflict and select");
  return { job: existing, created: false };
}

/**
 * Atomically claims up to `limit` runnable jobs for `workerId`.
 * `FOR UPDATE SKIP LOCKED` lets concurrent workers claim disjoint sets without blocking.
 */
export async function claimJobs(
  db: DbExecutor,
  options: { workerId: string; limit: number; leaseSeconds: number; types?: string[] },
): Promise<JobRow[]> {
  if (options.limit <= 0) return [];
  const runnable = db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.status, "queued"),
        lte(processingJobs.runAfter, sql`now()`),
        options.types?.length ? inArray(processingJobs.type, options.types) : undefined,
      ),
    )
    .orderBy(desc(processingJobs.priority), asc(processingJobs.runAfter))
    .limit(options.limit)
    .for("update", { skipLocked: true });

  return db
    .update(processingJobs)
    .set({
      status: "running",
      lockedBy: options.workerId,
      lockedUntil: sql`now() + make_interval(secs => ${options.leaseSeconds})`,
      heartbeatAt: sql`now()`,
      startedAt: sql`coalesce(${processingJobs.startedAt}, now())`,
      attemptCount: sql`${processingJobs.attemptCount} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(processingJobs.id, runnable))
    .returning();
}

/**
 * Extends the lease. Returns false if this worker no longer owns the job (lease expired and
 * the job was recovered) — the caller must then abandon the work without completing it.
 */
export async function heartbeatJob(
  db: DbExecutor,
  jobId: string,
  workerId: string,
  leaseSeconds: number,
  progress?: JobProgress,
): Promise<boolean> {
  const rows = await db
    .update(processingJobs)
    .set({
      lockedUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
      heartbeatAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(progress ? { progress } : {}),
    })
    .where(
      and(
        eq(processingJobs.id, jobId),
        eq(processingJobs.lockedBy, workerId),
        eq(processingJobs.status, "running"),
      ),
    )
    .returning({ id: processingJobs.id });
  return rows.length === 1;
}

export async function completeJob(
  db: DbExecutor,
  jobId: string,
  workerId: string,
  result?: Record<string, unknown>,
): Promise<boolean> {
  const rows = await db
    .update(processingJobs)
    .set({
      status: "completed",
      result: result ?? null,
      lockedBy: null,
      lockedUntil: null,
      completedAt: sql`now()`,
      updatedAt: sql`now()`,
      lastError: null,
      errorCode: null,
    })
    .where(
      and(
        eq(processingJobs.id, jobId),
        eq(processingJobs.lockedBy, workerId),
        eq(processingJobs.status, "running"),
      ),
    )
    .returning({ id: processingJobs.id });
  return rows.length === 1;
}

/** Exponential backoff with jitter: 5s, 10s, 20s … capped at 10 minutes. */
export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(600, 5 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface JobFailure {
  code: string;
  message: string;
  retryable: boolean;
}

/** Records a failure: re-queues with backoff when retryable and attempts remain, else fails. */
export async function failJob(
  db: DbExecutor,
  job: Pick<JobRow, "id" | "attemptCount" | "maxAttempts">,
  workerId: string,
  failure: JobFailure,
): Promise<"requeued" | "failed" | "lost"> {
  const willRetry = failure.retryable && job.attemptCount < job.maxAttempts;
  const rows = await db
    .update(processingJobs)
    .set({
      status: willRetry ? "queued" : "failed",
      runAfter: willRetry
        ? sql`now() + make_interval(secs => ${backoffSeconds(job.attemptCount)})`
        : undefined,
      lockedBy: null,
      lockedUntil: null,
      lastError: failure.message.slice(0, 4000),
      errorCode: failure.code,
      completedAt: willRetry ? null : sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(processingJobs.id, job.id),
        eq(processingJobs.lockedBy, workerId),
        eq(processingJobs.status, "running"),
      ),
    )
    .returning({ id: processingJobs.id });
  if (rows.length === 0) return "lost";
  return willRetry ? "requeued" : "failed";
}

/**
 * Recovers jobs whose lease expired (worker crashed or hung). Jobs with attempts left go back
 * to the queue; exhausted jobs fail with LEASE_EXPIRED. Returns the number of recovered jobs.
 */
export async function recoverExpiredLeases(db: DbExecutor): Promise<JobRow[]> {
  return db
    .update(processingJobs)
    .set({
      status: sql`case when ${processingJobs.attemptCount} >= ${processingJobs.maxAttempts} then 'failed' else 'queued' end`,
      completedAt: sql`case when ${processingJobs.attemptCount} >= ${processingJobs.maxAttempts} then now() else null end`,
      lockedBy: null,
      lockedUntil: null,
      runAfter: sql`now()`,
      errorCode: "LEASE_EXPIRED",
      lastError: sql`coalesce(${processingJobs.lastError}, 'worker lease expired before completion')`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(processingJobs.status, "running"), lte(processingJobs.lockedUntil, sql`now()`)))
    .returning();
}

/** Manually re-runs a failed or cancelled job from scratch (attempt counter reset). */
export async function retryJob(db: DbExecutor, jobId: string): Promise<JobRow | null> {
  const [row] = await db
    .update(processingJobs)
    .set({
      status: "queued",
      attemptCount: 0,
      runAfter: sql`now()`,
      lockedBy: null,
      lockedUntil: null,
      completedAt: null,
      lastError: null,
      errorCode: null,
      progress: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(processingJobs.id, jobId), inArray(processingJobs.status, ["failed", "cancelled"])),
    )
    .returning();
  return row ?? null;
}

/** Cancels a job that has not started. Running jobs cannot be cancelled mid-flight. */
export async function cancelQueuedJob(db: DbExecutor, jobId: string): Promise<boolean> {
  const rows = await db
    .update(processingJobs)
    .set({ status: "cancelled", completedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(processingJobs.id, jobId), eq(processingJobs.status, "queued")))
    .returning({ id: processingJobs.id });
  return rows.length === 1;
}

export async function getJobByIdempotencyKey(db: DbExecutor, key: string): Promise<JobRow | null> {
  const [row] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.idempotencyKey, key));
  return row ?? null;
}
