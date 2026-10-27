import { Readable } from "node:stream";
import { getDb } from "@/infrastructure/database/client";
import { getStorage, StorageObjectNotFoundError } from "@/infrastructure/storage";
import { shareThumbnail } from "@/modules/sharing";
import { refusal, SHARE_RESPONSE_HEADERS, shareRoute } from "../../_lib/access";

/** GET /s/:token/thumbnail — the shared version's generated WebP thumbnail (reading mode). */
export const GET = shareRoute(async ({ capability }) => {
  const thumbnail = await shareThumbnail(getDb(), capability);
  if (!thumbnail) return refusal("not_found");
  // A row that outlived its object (a reprocess race) is a 404, as on the preview origin.
  const object = await getStorage()
    .getObject(thumbnail.storageKey)
    .catch((error: unknown) => {
      if (error instanceof StorageObjectNotFoundError) return null;
      throw error;
    });
  if (!object) return refusal("not_found");
  const { body, info } = object;
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
    headers: {
      ...SHARE_RESPONSE_HEADERS,
      "content-type": thumbnail.mimeType,
      "content-length": String(info.size),
    },
  });
});
