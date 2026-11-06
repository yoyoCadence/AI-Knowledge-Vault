import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { restoreDeletedArtifact } from "@/modules/artifacts";
import { json } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

/**
 * POST /api/artifacts/:id/restore — undoes a soft delete: the artifact is back as it was, but
 * its share links are revoked (ADR-020), so old URLs never work again. A live artifact, or
 * another workspace's, is 404. Audited.
 */
export const POST = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Deleted artifact");
    return json({ artifact: await restoreDeletedArtifact(services.db(), actor, params.id, meta) });
  },
);
