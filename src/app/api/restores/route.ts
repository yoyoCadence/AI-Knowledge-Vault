import { createRestore, CreateRestoreInput, listRestores, toRestoreDto } from "@/modules/backup";
import { json, parseJsonBody } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

/** POST /api/restores — declare a backup archive; returns a signed upload (owner only). */
export const POST = authedRoute(
  { permission: "backup:restore" },
  async ({ request, actor, meta }) => {
    const input = await parseJsonBody(request, CreateRestoreInput);
    const { run, upload } = await createRestore(services.db(), services.storage(), actor, input, {
      maxArchiveBytes: services.env().RESTORE_MAX_ARCHIVE_BYTES,
      meta,
    });
    return json({ restore: toRestoreDto(run), upload }, { status: 201 });
  },
);

/** GET /api/restores — recent restore runs. */
export const GET = authedRoute({ permission: "backup:restore" }, async ({ actor }) => {
  const runs = await listRestores(services.db(), actor);
  return json({ items: runs.map(toRestoreDto) });
});
