import { createServer, type Server } from "node:http";
import type { JobWorker } from "@/modules/jobs";

/**
 * Minimal liveness endpoint for container platforms and E2E orchestration
 * (`GET /healthz` → 200). Enabled only when WORKER_HEALTH_PORT is set; exposes no data.
 */
export function startHealthServer(port: number, worker: JobWorker): Server {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok", workerId: worker.workerId }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1");
  return server;
}
