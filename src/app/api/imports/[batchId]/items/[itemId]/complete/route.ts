import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { completeItem, toItemDto } from "@/modules/imports";
import { json } from "../../../../../_lib/http";
import { authedRoute } from "../../../../../_lib/route";
import { services } from "../../../../../_lib/services";

/** POST /api/imports/:batchId/items/:itemId/complete — confirm the upload and queue processing (idempotent). */
export const POST = authedRoute<{ batchId: string; itemId: string }>(
  { permission: "import:create" },
  async ({ actor, params }) => {
    if (!isUuid(params.batchId) || !isUuid(params.itemId)) throw notFound("Import item");
    const item = await completeItem(
      services.db(),
      services.storage(),
      actor,
      params.batchId,
      params.itemId,
    );
    return json({ item: toItemDto(item) }, { status: 202 });
  },
);
