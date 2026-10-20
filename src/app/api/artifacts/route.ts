import { z } from "zod";
import { AppError } from "@/lib/errors";
import { listArtifacts } from "@/modules/artifacts";
import { json, parseQuery } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(200).optional(),
});

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [
      string,
      string,
    ];
    return { createdAt: new Date(createdAt), id };
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid cursor");
  }
}

/** GET /api/artifacts — library cards, newest first, cursor-paginated. */
export const GET = authedRoute({ permission: "library:read" }, async ({ request, actor }) => {
  const query = parseQuery(request, Query);
  const { items, nextCursor } = await listArtifacts(services.db(), actor, {
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
  });
  return json({
    items,
    nextCursor: nextCursor
      ? Buffer.from(JSON.stringify([nextCursor.createdAt.toISOString(), nextCursor.id])).toString(
          "base64url",
        )
      : null,
  });
});
