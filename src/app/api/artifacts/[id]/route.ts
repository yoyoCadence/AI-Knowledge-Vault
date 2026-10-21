import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { z } from "zod";
import { getArtifactDetail, tagsByArtifact, updateArtifact } from "@/modules/artifacts";
import { collectionsOf } from "@/modules/collections";
import { findProject } from "@/modules/projects";
import { json, parseJsonBody } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

/** GET /api/artifacts/:id — artifact with its versions (workspace-scoped; 404 otherwise). */
export const GET = authedRoute<{ id: string }>(
  { permission: "library:read" },
  async ({ actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    const { artifact, versions } = await getArtifactDetail(services.db(), actor, params.id);
    const tags = await tagsByArtifact(services.db(), actor.workspaceId, [artifact.id]);
    const collections = await collectionsOf(services.db(), actor.workspaceId, artifact.id);
    // A deleted project reads as none here too.
    const project = artifact.projectId
      ? await findProject(services.db(), actor, artifact.projectId)
      : null;
    return json({
      artifact: {
        id: artifact.id,
        title: artifact.title,
        description: artifact.description,
        summary: artifact.summary,
        visibility: artifact.visibility,
        sensitivity: artifact.sensitivity,
        reviewStatus: artifact.reviewStatus,
        projectId: project?.id ?? null,
        currentVersionId: artifact.currentVersionId,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
        tags: tags.get(artifact.id) ?? [],
        collections,
      },
      versions,
    });
  },
);

const UpdateArtifact = z
  .object({
    title: z.string().max(2_000).optional(),
    description: z.string().max(20_000).nullable().optional(),
    projectId: z.uuid().nullable().optional(),
  })
  .strict();

/**
 * PATCH /api/artifacts/:id `{title?, description?, projectId?}` — edit the artifact's own
 * metadata (never its originals or versions). `projectId: null` takes it out of its project.
 */
export const PATCH = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    const input = await parseJsonBody(request, UpdateArtifact);
    return json({ artifact: await updateArtifact(services.db(), actor, params.id, input, meta) });
  },
);
