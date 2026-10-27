import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { splitVersion } from "@/modules/artifacts";
import { json } from "../../../../../_lib/http";
import { authedRoute } from "../../../../../_lib/route";
import { services } from "../../../../../_lib/services";

/**
 * POST /api/artifacts/:id/versions/:versionId/split — moves the version to a new artifact of its
 * own (a wrong filename match undone). 201 `{artifact: {id, title}}`; 409 when it is the
 * artifact's only version.
 */
export const POST = authedRoute<{ id: string; versionId: string }>(
  { permission: "library:write" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id) || !isUuid(params.versionId)) throw notFound("Version");
    const result = await splitVersion(
      services.db(),
      actor,
      { artifactId: params.id, versionId: params.versionId },
      meta,
    );
    return json(result, { status: 201 });
  },
);
