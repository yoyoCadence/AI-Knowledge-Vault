import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { setArtifactTag } from "@/modules/tags";
import { json } from "../../../../_lib/http";
import { authedRoute } from "../../../../_lib/route";
import { services } from "../../../../_lib/services";

type Params = { id: string; tagId: string };

function handler(present: boolean) {
  return authedRoute<Params>({ permission: "library:write" }, async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    if (!isUuid(params.tagId)) throw notFound("Tag");
    const tags = await setArtifactTag(
      services.db(),
      actor,
      { artifactId: params.id, tagId: params.tagId, present },
      meta,
    );
    return json({ tags });
  });
}

/** PUT /api/artifacts/:id/tags/:tagId — tag the artifact (idempotent); returns its tags. */
export const PUT = handler(true);

/** DELETE /api/artifacts/:id/tags/:tagId — untag the artifact (idempotent); returns its tags. */
export const DELETE = handler(false);
