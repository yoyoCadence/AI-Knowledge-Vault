import { getUsageReport } from "@/modules/ops";
import { json } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

/**
 * GET /api/ops/usage — the workspace's usage and health (FR-OPS-2/3): storage by kind, library
 * size, the database's size, jobs by status and recent failures, failed imports, and the last
 * export and integrity check. Owners only (`workspace:admin`).
 */
export const GET = authedRoute({ permission: "workspace:admin" }, async ({ actor }) =>
  json(await getUsageReport(services.db(), actor)),
);
