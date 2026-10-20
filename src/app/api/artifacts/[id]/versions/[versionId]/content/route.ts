import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { getVersionContent } from "@/modules/artifacts";
import { json } from "../../../../../_lib/http";
import { authedRoute } from "../../../../../_lib/route";
import { services } from "../../../../../_lib/services";

/**
 * GET /api/artifacts/:id/versions/:versionId/content — reading-mode content (FR-LIB-4): the
 * active extraction's normalized Markdown, its method and its sections. 404 without one.
 */
export const GET = authedRoute<{ id: string; versionId: string }>(
  { permission: "library:read" },
  async ({ actor, params }) => {
    if (!isUuid(params.id) || !isUuid(params.versionId)) throw notFound("Version");
    const content = await getVersionContent(services.db(), actor, params.id, params.versionId);
    if (!content) throw notFound("Content");
    return json(content);
  },
);
