import { latestIntegrityCheck, toIntegrityDto } from "@/modules/backup";
import { json } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

/** GET /api/integrity-checks/latest — the newest check of the workspace, or null. */
export const GET = authedRoute({ permission: "library:read" }, async ({ actor }) => {
  const check = await latestIntegrityCheck(services.db(), actor);
  return json({ check: check ? toIntegrityDto(check) : null });
});
