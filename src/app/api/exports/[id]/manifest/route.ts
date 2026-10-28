import { contentDisposition } from "@/infrastructure/storage";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { exportSidecar } from "@/modules/backup";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

/**
 * GET /api/exports/:id/manifest — the sidecar of an encrypted copy (`…zip.age.manifest.json`):
 * what the archive holds and its SHA-256, readable without decrypting it. Nothing secret.
 */
export const GET = authedRoute<{ id: string }>(
  { permission: "backup:export" },
  async ({ actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Export");
    const { filename, sidecar } = await exportSidecar(services.db(), actor, params.id);
    return new Response(`${JSON.stringify(sidecar, null, 2)}\n`, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": contentDisposition(filename),
        "cache-control": "no-store",
      },
    });
  },
);
