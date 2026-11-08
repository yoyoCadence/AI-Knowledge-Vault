/**
 * Worker process entry point (ADR-005). Run with `pnpm worker:dev` (tsx) or
 * `node dist/worker.mjs` (bundled by `pnpm build:worker`).
 */
import { getEnv } from "@/infrastructure/config/env";
import { closeDb, getDb } from "@/infrastructure/database/client";
import { getLogger } from "@/infrastructure/observability/logger";
import { getStorage } from "@/infrastructure/storage";
import { JobWorker, setJobWakeHandler } from "@/modules/jobs";
import { buildJobRegistry } from "./registry";
import { startHealthServer } from "./health";
import { enqueueDueMaintenance, MAINTENANCE_TICK_MS } from "./scheduler";

async function main(): Promise<void> {
  process.env.SERVICE_NAME ??= "vault-worker";
  const env = getEnv();
  const logger = getLogger({ component: "worker" });

  const worker = new JobWorker({
    db: getDb(),
    storage: getStorage(),
    logger,
    registry: buildJobRegistry(env),
    concurrency: env.WORKER_CONCURRENCY,
    leaseSeconds: env.JOB_LEASE_SECONDS,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    idlePollIntervalMs: env.WORKER_IDLE_POLL_INTERVAL_MS,
    activeWindowMs: env.WORKER_ACTIVE_WINDOW_MS,
    // Maintenance scheduling shares the poll's database wake-up (ADR-024).
    periodic: [{ everyMs: MAINTENANCE_TICK_MS, run: () => enqueueDueMaintenance(getDb()) }],
    defaultTimeoutMs: env.IMPORT_ITEM_TIMEOUT_MS,
    shutdownGraceMs: env.WORKER_SHUTDOWN_GRACE_MS,
  });
  // Jobs enqueued in this process (by other jobs) wake this worker directly, not over HTTP.
  setJobWakeHandler(() => worker.wake());

  const healthServer = env.WORKER_HEALTH_PORT
    ? await startHealthServer(env.WORKER_HEALTH_PORT, worker, logger, {
        host: env.WORKER_HEALTH_HOST,
        wakeSecret: env.WORKER_WAKE_SECRET,
      })
    : null;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown requested");
    healthServer?.close();
    await worker.stop();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  worker.start();
}

main().catch((error: unknown) => {
  getLogger({ component: "worker" }).fatal({ err: error }, "worker failed to start");
  process.exit(1);
});
