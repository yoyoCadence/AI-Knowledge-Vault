import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/infrastructure/config/env";
import { notifyJobEnqueued, setJobWakeHandler } from "@/modules/jobs";

/** How an enqueue reaches an idle worker (ADR-024). */

const SECRET = "s".repeat(40);

async function wakeReceiver(status = 204) {
  const received: { method?: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    received.push({ method: request.method, headers: request.headers });
    response.writeHead(status).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/wake`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

afterEach(() => {
  setJobWakeHandler(undefined);
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("notifyJobEnqueued", () => {
  it("calls this process's handler when one is set (the worker wakes itself)", () => {
    let wakes = 0;
    setJobWakeHandler(() => (wakes += 1));
    notifyJobEnqueued();
    expect(wakes).toBe(1);
  });

  it("sends nothing when no wake URL is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      resetEnvCache();
      const { getEnv } = await import("@/infrastructure/config/env");
      expect(getEnv().WORKER_WAKE_URL).toBeUndefined(); // the test env sets none
      notifyJobEnqueued();
      await settle();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("POSTs to the worker with the shared secret, one wake at a time", async () => {
    const receiver = await wakeReceiver();
    try {
      vi.stubEnv("WORKER_WAKE_URL", receiver.url);
      vi.stubEnv("WORKER_WAKE_SECRET", SECRET);
      resetEnvCache();
      notifyJobEnqueued();
      notifyJobEnqueued(); // while the first is in flight: coalesced
      await settle();
      expect(receiver.received).toHaveLength(1);
      expect(receiver.received[0]).toMatchObject({
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      });
      notifyJobEnqueued(); // the first has finished
      await settle();
      expect(receiver.received).toHaveLength(2);
    } finally {
      await receiver.close();
    }
  });

  it("never throws, whether the worker refuses or cannot be reached", async () => {
    const refusing = await wakeReceiver(401);
    vi.stubEnv("WORKER_WAKE_SECRET", SECRET);
    try {
      vi.stubEnv("WORKER_WAKE_URL", refusing.url);
      resetEnvCache();
      expect(() => notifyJobEnqueued()).not.toThrow();
      await settle();
      expect(refusing.received).toHaveLength(1);
    } finally {
      await refusing.close();
    }
    vi.stubEnv("WORKER_WAKE_URL", refusing.url); // closed now
    resetEnvCache();
    expect(() => notifyJobEnqueued()).not.toThrow();
    await settle();
  });
});
