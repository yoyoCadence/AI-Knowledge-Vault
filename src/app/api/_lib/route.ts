import { getActor, assertCan, type Action, type Actor } from "@/modules/auth";
import { AppError } from "@/lib/errors";
import { assertSameOrigin, errorResponse, requestMeta } from "./http";

/**
 * Wraps an authenticated API route (NFR-SEC-1): CSRF check for mutations, authentication,
 * role permission, structured errors with error ids.
 */
export function authedRoute<P extends Record<string, string> = Record<string, never>>(
  options: { permission: Action },
  handler: (args: {
    request: Request;
    actor: Actor;
    params: P;
    meta: ReturnType<typeof requestMeta>;
  }) => Promise<Response>,
) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    try {
      assertSameOrigin(request);
      const actor = await getActor(request.headers);
      if (!actor) throw new AppError("UNAUTHENTICATED", "Authentication required");
      assertCan(actor, options.permission);
      const params = context?.params ? await context.params : ({} as P);
      return await handler({ request, actor, params, meta: requestMeta(request) });
    } catch (error) {
      return errorResponse(error, { route: new URL(request.url).pathname });
    }
  };
}
