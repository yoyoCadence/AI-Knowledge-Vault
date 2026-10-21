import { afterAll, describe, expect, it } from "vitest";
import { GET as searchRoute } from "@/app/api/search/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { newId } from "@/lib/ids";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

const search = (cookie: string, query: string) =>
  searchRoute(new Request(`${getEnv().APP_ORIGIN}/api/search?${query}`, { headers: { cookie } }), {
    params: Promise.resolve({}),
  });

type SearchDto = {
  items: {
    id: string;
    title: string;
    snippet: { segments: { text: string; highlight: boolean }[] } | null;
  }[];
  nextOffset: number | null;
};

describe("GET /api/search", () => {
  it("searches the caller's workspace and returns plain highlighted segments", async () => {
    const admin = await createTestAdmin();
    const { cookie } = await signInOk(admin.email, admin.password);
    const actor = {
      userId: admin.userId,
      workspaceId: admin.workspaceId,
      role: "owner" as const,
      sessionId: newId(),
      email: admin.email,
      name: "Owner",
    };
    await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "api-search.html",
      bytes: htmlDocument({ title: "API 搜尋", body: "<p>透水鋪面減少地表逕流。</p>" }),
    });
    await drainJobs();

    const response = await search(cookie, `q=${encodeURIComponent("透水鋪面")}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SearchDto;
    expect(body.items.map((item) => item.title)).toEqual(["API 搜尋"]);
    expect(body.items[0]!.snippet!.segments.find((segment) => segment.highlight)?.text).toBe(
      "透水鋪面",
    );
    expect(body.nextOffset).toBeNull();

    expect((await search(cookie, "q=")).status).toBe(400);
    expect((await search(cookie, `q=${"x".repeat(201)}`)).status).toBe(400);
    expect((await search(cookie, "q=a&offset=-1")).status).toBe(400);
    expect((await search("", "q=a")).status).toBe(401);
  });
});
