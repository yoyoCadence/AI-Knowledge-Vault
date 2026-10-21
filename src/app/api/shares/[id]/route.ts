import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { revokeShare } from "@/modules/sharing";
import { json } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

/** DELETE /api/shares/:id — revokes the link (idempotent): `{revoked: true}`. */
export const DELETE = authedRoute<{ id: string }>(
  { permission: "share:manage" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Share link");
    return json(await revokeShare(services.db(), actor, params.id, meta));
  },
);
