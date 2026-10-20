import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { createExportDownload } from "@/modules/backup";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

/**
 * GET /api/exports/:id/download — 302 to a 5-minute signed URL for a completed, unexpired
 * export archive. Audited; the archive's SHA-256 is exposed so the copy can be verified.
 */
export const GET = authedRoute<{ id: string }>(
  { permission: "backup:export" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Export");
    const download = await createExportDownload(
      services.db(),
      services.storage(),
      actor,
      params.id,
      meta,
    );
    return new Response(null, {
      status: 302,
      headers: {
        location: download.url,
        "cache-control": "no-store",
        "x-content-sha256": download.sha256,
      },
    });
  },
);
