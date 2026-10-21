import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { getArtifactDetail, tagsByArtifact } from "@/modules/artifacts";
import { json } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

/** GET /api/artifacts/:id — artifact with its versions (workspace-scoped; 404 otherwise). */
export const GET = authedRoute<{ id: string }>(
  { permission: "library:read" },
  async ({ actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    const { artifact, versions } = await getArtifactDetail(services.db(), actor, params.id);
    const tags = await tagsByArtifact(services.db(), actor.workspaceId, [artifact.id]);
    return json({
      artifact: {
        id: artifact.id,
        title: artifact.title,
        description: artifact.description,
        summary: artifact.summary,
        visibility: artifact.visibility,
        sensitivity: artifact.sensitivity,
        reviewStatus: artifact.reviewStatus,
        projectId: artifact.projectId,
        currentVersionId: artifact.currentVersionId,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
        tags: tags.get(artifact.id) ?? [],
      },
      versions,
    });
  },
);
