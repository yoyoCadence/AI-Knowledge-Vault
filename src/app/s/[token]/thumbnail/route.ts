import { Readable } from "node:stream";
import { getDb } from "@/infrastructure/database/client";
import { getStorage } from "@/infrastructure/storage";
import { shareThumbnail } from "@/modules/sharing";
import { refusal, SHARE_RESPONSE_HEADERS, shareRoute } from "../../_lib/access";

/** GET /s/:token/thumbnail — the shared version's generated WebP thumbnail (reading mode). */
export const GET = shareRoute(async ({ capability }) => {
  const thumbnail = await shareThumbnail(getDb(), capability);
  if (!thumbnail) return refusal("not_found");
  const { body, info } = await getStorage().getObject(thumbnail.storageKey);
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
    headers: {
      ...SHARE_RESPONSE_HEADERS,
      "content-type": thumbnail.mimeType,
      "content-length": String(info.size),
    },
  });
});
