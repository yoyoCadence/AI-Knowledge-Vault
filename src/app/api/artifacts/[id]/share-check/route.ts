import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { checkShare } from "@/modules/sharing";
import { json } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

/**
 * POST /api/artifacts/:id/share-check — the advisory pre-share scan (FR-SHR-3):
 * `{findings, blocked, visibility}`. Samples are masked; `blocked` means restricted.
 */
export const POST = authedRoute<{ id: string }>(
  { permission: "share:manage" },
  async ({ actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    return json(await checkShare(services.db(), actor, params.id));
  },
);
