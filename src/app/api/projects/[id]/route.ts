import { z } from "zod";
import { PROJECT_STATUSES } from "@/infrastructure/database/schema";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { deleteProject, findProject, updateProject } from "@/modules/projects";
import { json, parseJsonBody } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

const UpdateProject = z.object({
  title: z.string().max(1_000).optional(),
  description: z.string().max(10_000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});

/** GET /api/projects/:id — one project of the workspace (404 otherwise, also when deleted). */
export const GET = authedRoute<{ id: string }>(
  { permission: "library:read" },
  async ({ actor, params }) => {
    const project = isUuid(params.id) ? await findProject(services.db(), actor, params.id) : null;
    if (!project) throw notFound("Research project");
    return json({ project });
  },
);

/** PATCH /api/projects/:id `{title?, description?, status?}` — rename, describe, archive. */
export const PATCH = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Research project");
    const input = await parseJsonBody(request, UpdateProject);
    return json({ project: await updateProject(services.db(), actor, params.id, input, meta) });
  },
);

/** DELETE /api/projects/:id — soft delete; its artifacts stay and keep their reference. */
export const DELETE = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Research project");
    await deleteProject(services.db(), actor, params.id, meta);
    return json({ deleted: true });
  },
);
