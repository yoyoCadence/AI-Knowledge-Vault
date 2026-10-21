import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getArtifact, PATCH as patchArtifact } from "@/app/api/artifacts/[id]/route";
import { GET as listArtifactsRoute } from "@/app/api/artifacts/route";
import {
  DELETE as deleteProjectRoute,
  GET as getProjectRoute,
  PATCH as patchProjectRoute,
} from "@/app/api/projects/[id]/route";
import { GET as listProjectsRoute, POST as createProjectRoute } from "@/app/api/projects/route";
import { GET as searchRoute } from "@/app/api/search/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { workspaceMembers } from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

type Project = { id: string; title: string; description: string | null; status: string };
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

function request(path: string, init: { method?: string; cookie: string; body?: unknown }) {
  return new Request(`${getEnv().APP_ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      cookie: init.cookie,
      origin: getEnv().APP_ORIGIN,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function loggedIn() {
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
  return { ...admin, cookie, actor };
}

describe("projects API and artifact editing (API_CONTRACT §5–§7)", () => {
  let owner: Awaited<ReturnType<typeof loggedIn>>;
  let artifactId: string;

  beforeAll(async () => {
    owner = await loggedIn();
    await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
      filename: "projects-api.html",
      bytes: htmlDocument({ title: "專案 API 測試", body: "<p>屋頂花園的排水。</p>" }),
    });
    await drainJobs();
    const listed = (await (
      await listArtifactsRoute(request("/api/artifacts", { cookie: owner.cookie }), params({}))
    ).json()) as { items: { id: string }[] };
    artifactId = listed.items[0]!.id;
  });

  const create = (body: unknown, cookie = owner.cookie) =>
    createProjectRoute(request("/api/projects", { method: "POST", cookie, body }), params({}));
  const patch = (id: string, body: unknown, cookie = owner.cookie) =>
    patchArtifact(
      request(`/api/artifacts/${id}`, { method: "PATCH", cookie, body }),
      params({ id }),
    );

  it("creates, reads, updates, lists and deletes projects", async () => {
    const created = await create({ title: "  海綿城市  ", description: "保水研究" });
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: Project };
    expect(project).toMatchObject({ title: "海綿城市", description: "保水研究", status: "active" });

    const read = await getProjectRoute(
      request(`/api/projects/${project.id}`, { cookie: owner.cookie }),
      params({ id: project.id }),
    );
    expect(((await read.json()) as { project: Project }).project.id).toBe(project.id);

    const archived = await patchProjectRoute(
      request(`/api/projects/${project.id}`, {
        method: "PATCH",
        cookie: owner.cookie,
        body: { status: "archived" },
      }),
      params({ id: project.id }),
    );
    expect(((await archived.json()) as { project: Project }).project.status).toBe("archived");
    const list = (await (
      await listProjectsRoute(request("/api/projects", { cookie: owner.cookie }), params({}))
    ).json()) as { items: (Project & { artifactCount: number })[] };
    expect(list.items.map((item) => item.id)).toContain(project.id);

    const deleted = await deleteProjectRoute(
      request(`/api/projects/${project.id}`, { method: "DELETE", cookie: owner.cookie }),
      params({ id: project.id }),
    );
    expect(deleted.status).toBe(200);
    expect(
      (
        await getProjectRoute(
          request(`/api/projects/${project.id}`, { cookie: owner.cookie }),
          params({ id: project.id }),
        )
      ).status,
    ).toBe(404);

    expect((await create({ title: "" })).status).toBe(400);
    expect((await create({ title: 42 })).status).toBe(400);
    expect(
      (
        await patchProjectRoute(
          request(`/api/projects/${project.id}`, {
            method: "PATCH",
            cookie: owner.cookie,
            body: { status: "gone" },
          }),
          params({ id: project.id }),
        )
      ).status,
    ).toBe(400);
  });

  it("edits an artifact's title, description and project; filters follow", async () => {
    const { project } = (await (await create({ title: "排水研究" })).json()) as {
      project: Project;
    };
    const edited = await patch(artifactId, {
      title: "專案 API 測試（改）",
      description: "排水設計",
      projectId: project.id,
    });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { artifact: { projectId: string } }).artifact.projectId).toBe(
      project.id,
    );
    const detail = (await (
      await getArtifact(
        request(`/api/artifacts/${artifactId}`, { cookie: owner.cookie }),
        params({ id: artifactId }),
      )
    ).json()) as { artifact: { title: string; description: string; projectId: string } };
    expect(detail.artifact).toMatchObject({
      title: "專案 API 測試（改）",
      description: "排水設計",
      projectId: project.id,
    });

    const byProject = (await (
      await listArtifactsRoute(
        request(`/api/artifacts?project=${project.id}&sort=oldest`, { cookie: owner.cookie }),
        params({}),
      )
    ).json()) as { items: { id: string }[] };
    expect(byProject.items.map((item) => item.id)).toEqual([artifactId]);
    const searched = (await (
      await searchRoute(
        request(
          `/api/search?q=${encodeURIComponent("排水")}&project=${project.id}&kind=html_document&sort=title`,
          { cookie: owner.cookie },
        ),
        params({}),
      )
    ).json()) as { items: { id: string }[]; total: number };
    expect(searched).toMatchObject({ total: 1 });
    expect(searched.items.map((item) => item.id)).toEqual([artifactId]);

    for (const query of [
      "kind=nope",
      "from=2026-13-01",
      "from=0000-01-01",
      "to=0000-02-29",
      "model=%00",
      "sort=title",
      "project=x",
    ]) {
      const response = await listArtifactsRoute(
        request(`/api/artifacts?${query}`, { cookie: owner.cookie }),
        params({}),
      );
      expect(response.status, query).toBe(400);
    }
    for (const query of ["from=0000-01-01", "model=a%00b"]) {
      const response = await searchRoute(
        request(`/api/search?q=${encodeURIComponent("排水")}&${query}`, { cookie: owner.cookie }),
        params({}),
      );
      expect(response.status, query).toBe(400);
    }
    expect((await patch(artifactId, { title: "" })).status).toBe(400);
    expect((await patch(artifactId, { visibility: "public" })).status).toBe(400); // not editable here
    expect((await patch(artifactId, {})).status).toBe(400);
    expect((await patch(artifactId, { projectId: newId() })).status).toBe(404);
    expect((await patch("not-a-uuid", { title: "x" })).status).toBe(404);

    // Once the project is deleted, the artifact reads as having none.
    await deleteProjectRoute(
      request(`/api/projects/${project.id}`, { method: "DELETE", cookie: owner.cookie }),
      params({ id: project.id }),
    );
    const after = (await (
      await getArtifact(
        request(`/api/artifacts/${artifactId}`, { cookie: owner.cookie }),
        params({ id: artifactId }),
      )
    ).json()) as { artifact: { projectId: string | null } };
    expect(after.artifact.projectId).toBeNull();
  });

  it("is invisible to other workspaces and read-only for viewers", async () => {
    const { project } = (await (await create({ title: "私人專案" })).json()) as {
      project: Project;
    };
    const stranger = await loggedIn();
    expect((await patch(artifactId, { title: "偷改" }, stranger.cookie)).status).toBe(404);
    expect(
      (
        await getProjectRoute(
          request(`/api/projects/${project.id}`, { cookie: stranger.cookie }),
          params({ id: project.id }),
        )
      ).status,
    ).toBe(404);
    const theirs = (await (await create({ title: "他們的" }, stranger.cookie)).json()) as {
      project: Project;
    };
    expect((await patch(artifactId, { projectId: theirs.project.id })).status).toBe(404);

    const viewer = await loggedIn();
    await testDb()
      .update(workspaceMembers)
      .set({ role: "viewer" })
      .where(eq(workspaceMembers.userId, viewer.userId));
    expect((await create({ title: "檢視者" }, viewer.cookie)).status).toBe(403);
    expect(
      (await listProjectsRoute(request("/api/projects", { cookie: viewer.cookie }), params({})))
        .status,
    ).toBe(200);
  });
});
