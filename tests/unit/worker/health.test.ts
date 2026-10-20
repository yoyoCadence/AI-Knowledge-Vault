import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { getLogger } from "@/infrastructure/observability/logger";
import type { JobWorker } from "@/modules/jobs";
import { startHealthServer } from "@/worker/health";

const worker = { workerId: "health-test" } as JobWorker;
const logger = getLogger({ test: true });

describe("worker health server", () => {
  it("serves /healthz and rejects (instead of crashing) when the port is taken", async () => {
    const server = await startHealthServer(0, worker, logger);
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok", workerId: "health-test" });
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);

      await expect(startHealthServer(port, worker, logger)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
