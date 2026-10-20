import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { declareItem, DeclareItemInput, toItemDto } from "@/modules/imports";
import { json, parseJsonBody } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

/** POST /api/imports/:batchId/items — declare a file and receive a direct-upload URL. */
export const POST = authedRoute<{ batchId: string }>(
  { permission: "import:create" },
  async ({ request, actor, params }) => {
    if (!isUuid(params.batchId)) throw notFound("Import batch");
    const input = await parseJsonBody(request, DeclareItemInput);
    const { item, upload, created } = await declareItem(
      services.db(),
      services.storage(),
      actor,
      params.batchId,
      input,
      services.importLimits(),
    );
    return json({ item: toItemDto(item), upload }, { status: created ? 201 : 200 });
  },
);
