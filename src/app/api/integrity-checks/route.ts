import { requestIntegrityCheck, toIntegrityDto } from "@/modules/backup";
import { json } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

/** POST /api/integrity-checks — re-hash every original of the workspace (BACKUP_RECOVERY §7). */
export const POST = authedRoute({ permission: "backup:export" }, async ({ actor, meta }) => {
  const check = await requestIntegrityCheck(services.db(), actor.workspaceId, {
    actorUserId: actor.userId,
    meta,
  });
  return json({ check: toIntegrityDto(check) }, { status: 202 });
});
