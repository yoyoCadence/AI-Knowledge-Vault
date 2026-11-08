import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { getLogger } from "@/infrastructure/observability/logger";
import type { JobWorker } from "@/modules/jobs";
import { startHealthServer } from "@/worker/health";

const worker = { workerId: "health-test", wake: () => {} } as unknown as JobWorker;
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

  it("wakes the worker on an authorized POST /wake, and only then", async () => {
    let wakes = 0;
    const counted = { workerId: "wake-test", wake: () => (wakes += 1) };
    const secret = "w".repeat(40);
    const server = await startHealthServer(0, counted, logger, { wakeSecret: secret });
    try {
      const { port } = server.address() as AddressInfo;
      const wake = (init: RequestInit) => fetch(`http://127.0.0.1:${port}/wake`, init);
      expect((await wake({ method: "POST" })).status).toBe(401);
      expect(
        (await wake({ method: "POST", headers: { authorization: `Bearer ${"x".repeat(40)}` } }))
          .status,
      ).toBe(401);
      expect(
        (await wake({ method: "POST", headers: { authorization: `Bearer ${secret}x` } })).status,
      ).toBe(401);
      expect((await wake({ method: "GET" })).status).toBe(405);
      expect(wakes).toBe(0);
      expect(
        (await wake({ method: "POST", headers: { authorization: `Bearer ${secret}` } })).status,
      ).toBe(204);
      expect(wakes).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("has no /wake without a secret", async () => {
    let wakes = 0;
    const server = await startHealthServer(
      0,
      { workerId: "no-wake", wake: () => (wakes += 1) },
      logger,
    );
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/wake`, {
        method: "POST",
        headers: { authorization: "Bearer " },
      });
      expect(response.status).toBe(404);
      expect(wakes).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
