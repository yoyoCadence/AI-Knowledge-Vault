import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { createOriginalDownload } from "@/modules/artifacts";
import { authedRoute } from "../../../../../_lib/route";
import { services } from "../../../../../_lib/services";

/**
 * GET /api/artifacts/:id/versions/:versionId/original — 302 to a 5-minute signed URL for the
 * immutable original (FR-FILE-2). Audited. The SHA-256 is exposed so clients can verify bytes.
 */
export const GET = authedRoute<{ id: string; versionId: string }>(
  { permission: "library:read" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id) || !isUuid(params.versionId)) throw notFound("Version");
    const download = await createOriginalDownload(
      services.db(),
      services.storage(),
      actor,
      { artifactId: params.id, versionId: params.versionId },
      meta,
    );
    return new Response(null, {
      status: 302,
      headers: {
        location: download.url,
        "cache-control": "no-store",
        "x-content-sha256": download.sha256,
      },
    });
  },
);
