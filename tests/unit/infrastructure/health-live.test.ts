import { describe, expect, it, vi } from "vitest";

// The liveness probe must answer without the database or storage (ADR-024): a platform probing
// it every few seconds would otherwise keep a database that scales to zero awake.
vi.mock("@/infrastructure/database/client", () => ({
  getDb: () => {
    throw new Error("the liveness probe touched the database");
  },
}));
vi.mock("@/infrastructure/storage", () => ({
  getStorage: () => {
    throw new Error("the liveness probe touched storage");
  },
}));

const { GET } = await import("@/app/api/health/live/route");

describe("GET /api/health/live", () => {
  it("answers ok without the database or storage", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
