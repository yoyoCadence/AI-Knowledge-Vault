import { listExports, requestExport, toExportDto } from "@/modules/backup";
import { json } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

/** POST /api/exports — queue a portable export of the workspace (BACKUP_RECOVERY §3). */
export const POST = authedRoute({ permission: "backup:export" }, async ({ actor, meta }) => {
  const run = await requestExport(services.db(), actor, meta);
  return json({ export: toExportDto(run) }, { status: 202 });
});

/** GET /api/exports — recent export runs, newest first. */
export const GET = authedRoute({ permission: "backup:export" }, async ({ actor }) => {
  const runs = await listExports(services.db(), actor);
  return json({ items: runs.map(toExportDto) });
});
