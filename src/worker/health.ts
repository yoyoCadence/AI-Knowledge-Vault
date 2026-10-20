import { createServer, type Server } from "node:http";
import type { Logger } from "@/infrastructure/observability/logger";
import type { JobWorker } from "@/modules/jobs";

/**
 * Minimal liveness endpoint (`GET /healthz` → 200) for Docker HEALTHCHECK / exec probes and
 * E2E orchestration. Enabled only when WORKER_HEALTH_PORT is set; exposes no data. Binds to
 * 127.0.0.1 on purpose, so it is reachable from inside the container only (a network probe such
 * as a Kubernetes httpGet would need an exec probe instead).
 *
 * Resolves once listening. A bind failure (e.g. EADDRINUSE) rejects *before* the worker starts
 * claiming jobs, so the process exits cleanly instead of crashing mid-job.
 */
export function startHealthServer(
  port: number,
  worker: JobWorker,
  logger: Logger,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok", workerId: worker.workerId }));
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      // Later errors (rare after a successful bind) are logged, never thrown.
      server.on("error", (error) => logger.error({ err: error }, "health server error"));
      resolve(server);
    });
  });
}
