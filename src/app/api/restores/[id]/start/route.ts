import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { startRestore, StartRestoreInput, toRestoreDto } from "@/modules/backup";
import { json, parseJsonBody } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

/** POST /api/restores/:id/start — `{mode}`; queues the verified restore (idempotent). */
export const POST = authedRoute<{ id: string }>(
  { permission: "backup:restore" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Restore");
    const input = await parseJsonBody(request, StartRestoreInput);
    const run = await startRestore(
      services.db(),
      services.storage(),
      actor,
      params.id,
      input,
      meta,
    );
    return json({ restore: toRestoreDto(run) }, { status: 202 });
  },
);
