import { getDb } from "@/infrastructure/database/client";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { revokeSession } from "@/modules/auth";
import { json } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";

/** DELETE /api/sessions/:id — revoke one of the actor's sessions (audited). */
export const DELETE = authedRoute<{ id: string }>(
  { permission: "library:read" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Session");
    const revoked = await revokeSession(getDb(), actor, params.id, meta);
    if (!revoked) throw notFound("Session");
    return json({ revoked: true });
  },
);
