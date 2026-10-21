import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { setCollectionItem } from "@/modules/collections";
import { json } from "../../../../_lib/http";
import { authedRoute } from "../../../../_lib/route";
import { services } from "../../../../_lib/services";

type Params = { id: string; artifactId: string };

function handler(present: boolean) {
  return authedRoute<Params>({ permission: "library:write" }, async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Collection");
    if (!isUuid(params.artifactId)) throw notFound("Artifact");
    const collections = await setCollectionItem(
      services.db(),
      actor,
      { collectionId: params.id, artifactId: params.artifactId, present },
      meta,
    );
    return json({ collections });
  });
}

/**
 * PUT /api/collections/:id/items/:artifactId — put the artifact in the collection (idempotent);
 * returns the artifact's collections with their paths.
 */
export const PUT = handler(true);

/** DELETE /api/collections/:id/items/:artifactId — take it out (idempotent); same response. */
export const DELETE = handler(false);
