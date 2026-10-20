import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { getBatchReport, toBatchDto, toItemDto } from "@/modules/imports";
import { json } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

/** GET /api/imports/:batchId — import report (FR-IMP-10). */
export const GET = authedRoute<{ batchId: string }>(
  { permission: "library:read" },
  async ({ actor, params }) => {
    if (!isUuid(params.batchId)) throw notFound("Import batch");
    const report = await getBatchReport(services.db(), actor, params.batchId);
    return json({
      batch: toBatchDto(report.batch),
      counts: report.counts,
      items: report.items.map(toItemDto),
    });
  },
);
