import { getEnv } from "@/infrastructure/config/env";
import { getLogger } from "@/infrastructure/observability/logger";

/**
 * Telling the worker that a job was enqueued (ADR-024). An idle worker polls rarely, so that a
 * database which scales to zero can sleep; a wake makes it poll now.
 *
 * - In the worker process the wake is direct: main.ts sets a handler (`setJobWakeHandler`).
 * - Elsewhere (the web, a CLI): an HTTP POST to `WORKER_WAKE_URL`, authorized with
 *   `WORKER_WAKE_SECRET`, when configured. Not configured, nothing is sent: the worker polls
 *   often anyway unless `WORKER_IDLE_POLL_INTERVAL_MS` was raised.
 *
 * Fire and forget. A lost wake costs time (the job waits for the next idle poll), never the
 * job, which is already in the queue.
 */
type WakeHandler = () => void;

const globalForWake = globalThis as unknown as {
  __vaultJobWake?: WakeHandler;
  __vaultWakeInFlight?: boolean;
  __vaultWakeWarnedAt?: number;
};

/** Sets how this process wakes the worker; `undefined` restores the HTTP wake. */
export function setJobWakeHandler(handler: WakeHandler | undefined): void {
  globalForWake.__vaultJobWake = handler;
}

export function notifyJobEnqueued(): void {
  try {
    (globalForWake.__vaultJobWake ?? wakeOverHttp)();
  } catch {
    // Never let a wake break the enqueue that called it.
  }
}

const WAKE_TIMEOUT_MS = 2_000;

function wakeOverHttp(): void {
  const env = getEnv();
  if (!env.WORKER_WAKE_URL || !env.WORKER_WAKE_SECRET) return;
  // One wake at a time: the worker stays active for its active window after one, so the jobs
  // enqueued meanwhile are found anyway.
  if (globalForWake.__vaultWakeInFlight) return;
  globalForWake.__vaultWakeInFlight = true;
  void fetch(env.WORKER_WAKE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WORKER_WAKE_SECRET}` },
    signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`worker wake answered ${response.status}`);
    })
    .catch((error: unknown) => {
      // At most one warning a minute: an unreachable worker would otherwise log every enqueue.
      const now = Date.now();
      if (now - (globalForWake.__vaultWakeWarnedAt ?? 0) < 60_000) return;
      globalForWake.__vaultWakeWarnedAt = now;
      getLogger({ component: "jobs" }).warn(
        { err: error },
        "could not wake the worker; the job waits for its next idle poll",
      );
    })
    .finally(() => {
      globalForWake.__vaultWakeInFlight = false;
    });
}
