import { z } from "zod";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { updateVersionSource } from "@/modules/artifacts";
import { json, parseJsonBody } from "../../../../_lib/http";
import { authedRoute } from "../../../../_lib/route";
import { services } from "../../../../_lib/services";

const field = z.string().max(4_000).nullable().optional();
const UpdateVersionSource = z
  .object({
    sourcePlatform: field,
    sourceModel: field,
    researchDate: field,
    author: field,
    sourceUrl: field,
  })
  .strict();

/**
 * PATCH /api/artifacts/:id/versions/:versionId `{sourcePlatform?, sourceModel?, researchDate?,
 * author?, sourceUrl?}` — edit where the version came from (never its file); `null` or empty
 * clears a field. Returns `{version}` with the five fields.
 */
export const PATCH = authedRoute<{ id: string; versionId: string }>(
  { permission: "library:write" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id) || !isUuid(params.versionId)) throw notFound("Version");
    const edit = await parseJsonBody(request, UpdateVersionSource);
    const version = await updateVersionSource(
      services.db(),
      actor,
      { artifactId: params.id, versionId: params.versionId },
      edit,
      meta,
    );
    return json({ version });
  },
);
