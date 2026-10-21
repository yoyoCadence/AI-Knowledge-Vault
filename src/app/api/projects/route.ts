import { z } from "zod";
import { createProject, listProjects } from "@/modules/projects";
import { json, parseJsonBody } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

const CreateProject = z.object({
  title: z.string().max(1_000),
  description: z.string().max(10_000).nullish(),
});

/** GET /api/projects — the workspace's research projects with artifact counts. */
export const GET = authedRoute({ permission: "library:read" }, async ({ actor }) => {
  return json({ items: await listProjects(services.db(), actor) });
});

/** POST /api/projects `{title, description?}` — create a research project. */
export const POST = authedRoute(
  { permission: "library:write" },
  async ({ request, actor, meta }) => {
    const input = await parseJsonBody(request, CreateProject);
    const project = await createProject(services.db(), actor, input, meta);
    return json({ project }, { status: 201 });
  },
);
