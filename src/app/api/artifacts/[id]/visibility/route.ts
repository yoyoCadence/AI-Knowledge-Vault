import { z } from "zod";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { setVisibility, SHAREABLE_VISIBILITIES } from "@/modules/sharing";
import { json, parseJsonBody } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

const SetVisibility = z.object({ visibility: z.enum(SHAREABLE_VISIBILITIES) }).strict();

/**
 * PUT /api/artifacts/:id/visibility `{visibility: "private" | "unlisted"}` — `{visibility,
 * revoked}`. Making an artifact private revokes all its links for good.
 */
export const PUT = authedRoute<{ id: string }>(
  { permission: "share:manage" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    const { visibility } = await parseJsonBody(request, SetVisibility);
    return json(await setVisibility(services.db(), actor, params.id, visibility, meta));
  },
);
