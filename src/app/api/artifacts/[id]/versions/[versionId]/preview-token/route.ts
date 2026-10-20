import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { issuePreviewUrl } from "@/modules/preview";
import { json } from "../../../../../_lib/http";
import { authedRoute } from "../../../../../_lib/route";
import { services } from "../../../../../_lib/services";

/**
 * POST /api/artifacts/:id/versions/:versionId/preview-token — a 15-minute URL on PREVIEW_ORIGIN
 * for the version's sandboxed site preview (FR-PRV-2). 404 when the version has none.
 */
export const POST = authedRoute<{ id: string; versionId: string }>(
  { permission: "library:read" },
  async ({ actor, params }) => {
    if (!isUuid(params.id) || !isUuid(params.versionId)) throw notFound("Version");
    const preview = await issuePreviewUrl(
      services.db(),
      actor,
      { artifactId: params.id, versionId: params.versionId },
      services.env(),
    );
    if (!preview) throw notFound("Preview");
    return json({
      url: preview.url,
      expiresAt: preview.expiresAt.toISOString(),
      expiresInSeconds: preview.expiresInSeconds,
    });
  },
);
