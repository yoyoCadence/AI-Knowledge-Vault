import type { Database } from "@/infrastructure/database/client";
import type { JobProgress } from "@/infrastructure/database/schema";
import type { Logger } from "@/infrastructure/observability/logger";
import type { StorageAdapter } from "@/infrastructure/storage";
import type { JobRow } from "./queue";

export interface JobContext {
  job: JobRow;
  db: Database;
  storage: StorageAdapter;
  logger: Logger;
  /** Aborted on timeout, lease loss, or worker shutdown. Long handlers must check it. */
  signal: AbortSignal;
  reportProgress(progress: JobProgress): Promise<void>;
}

/** Returns an optional small JSON result stored on the job row. */
export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

export interface JobDefinition {
  type: string;
  handler: JobHandler;
  /** Per-attempt timeout. Defaults to the worker's default. */
  timeoutMs?: number;
}

/** Explicit registry: the worker only runs job types registered here. */
export class JobRegistry {
  private readonly definitions = new Map<string, JobDefinition>();

  register(definition: JobDefinition): this {
    if (this.definitions.has(definition.type)) {
      throw new Error(`job type already registered: ${definition.type}`);
    }
    this.definitions.set(definition.type, definition);
    return this;
  }

  get(type: string): JobDefinition | undefined {
    return this.definitions.get(type);
  }

  types(): string[] {
    return [...this.definitions.keys()];
  }
}
