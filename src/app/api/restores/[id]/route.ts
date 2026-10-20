import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { getRestore, toRestoreDto } from "@/modules/backup";
import { json } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

/** GET /api/restores/:id — status and report of one restore run. */
export const GET = authedRoute<{ id: string }>(
  { permission: "backup:restore" },
  async ({ actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Restore");
    return json({ restore: toRestoreDto(await getRestore(services.db(), actor, params.id)) });
  },
);
