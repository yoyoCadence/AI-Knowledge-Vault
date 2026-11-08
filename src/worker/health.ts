import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Logger } from "@/infrastructure/observability/logger";
import type { JobWorker } from "@/modules/jobs";

/**
 * The worker's small HTTP server, enabled only when WORKER_HEALTH_PORT is set. It exposes no
 * data.
 *
 * - `GET /healthz` → 200: liveness, for Docker HEALTHCHECK / exec probes and E2E orchestration.
 * - `POST /wake` → 204: a job was enqueued, poll now (ADR-024). It needs
 *   `Authorization: Bearer <WORKER_WAKE_SECRET>`, and is off (404) without a secret. A wake
 *   can only make the worker poll sooner, but an open one would let anyone keep a database
 *   that scales to zero awake, and spend its compute.
 *
 * It binds to `host`: 127.0.0.1 by default, reachable from inside the container only. Use `::`
 * when the web wakes the worker over the platform's private network.
 *
 * Resolves once listening. A bind failure (e.g. EADDRINUSE) rejects *before* the worker starts
 * claiming jobs, so the process exits cleanly instead of crashing mid-job.
 */
export function startHealthServer(
  port: number,
  worker: Pick<JobWorker, "workerId" | "wake">,
  logger: Logger,
  options: { host?: string; wakeSecret?: string } = {},
): Promise<Server> {
  const expected = options.wakeSecret ? Buffer.from(`Bearer ${options.wakeSecret}`) : null;
  const authorized = (header: string | undefined) => {
    if (!expected || !header) return false;
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok", workerId: worker.workerId }));
      return;
    }
    if (request.url === "/wake" && expected) {
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
        return;
      }
      if (!authorized(request.headers.authorization)) {
        response.writeHead(401).end();
        return;
      }
      worker.wake();
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  // Wakes carry no body worth waiting for.
  server.requestTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      // Later errors (rare after a successful bind) are logged, never thrown.
      server.on("error", (error) => logger.error({ err: error }, "health server error"));
      resolve(server);
    });
  });
}
