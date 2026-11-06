import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "@/components/artifacts/api";
import { tagRequest } from "@/components/tags/api";
import { t } from "@/lib/i18n";

/**
 * What the editors show when a request fails (they display the thrown Error's message). The
 * browser's own words for a dropped connection ("Failed to fetch", "Load failed") are English
 * and say nothing useful; a 401 used to read "please try again", which can never work.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const offline = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );

const answer = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );

const helpers = [
  ["jsonRequest", (url: string) => jsonRequest(url, { method: "POST", body: {} })],
  ["tagRequest", (url: string) => tagRequest(url, { method: "POST", body: {} })],
] as const;

describe.each(helpers)("%s", (_name, request) => {
  it("says the request did not get through when the network fails", async () => {
    offline();
    await expect(request("/api/anything")).rejects.toThrow(t("request.error.network"));
  });

  it("says the session ended on a 401, instead of asking to try again", async () => {
    answer(401, { error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
    await expect(request("/api/anything")).rejects.toThrow(t("request.error.signedOut"));
  });

  it("keeps its own messages for other failures, and returns the body on success", async () => {
    answer(500, { error: { code: "INTERNAL_ERROR", message: "Internal error" } });
    await expect(request("/api/anything")).rejects.toThrow(/再試一次/);
    answer(200, { ok: true });
    await expect(request("/api/anything")).resolves.toEqual({ ok: true });
  });
});

describe("jsonRequest", () => {
  it("still maps a 404 to the caller's 'gone' message", async () => {
    answer(404, { error: { code: "NOT_FOUND", message: "Artifact not found" } });
    await expect(
      jsonRequest("/api/anything", { method: "DELETE" }, { gone: "已經不存在" }),
    ).rejects.toThrow("已經不存在");
  });
});
