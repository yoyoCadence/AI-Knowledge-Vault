import { Readable } from "node:stream";
import { getLogger } from "@/infrastructure/observability/logger";
import { StorageObjectNotFoundError } from "@/infrastructure/storage";
import { newErrorId } from "@/lib/ids";
import {
  findPreviewFile,
  normalizePreviewPath,
  previewContentType,
  previewHeaders,
  verifyPreviewToken,
} from "@/modules/preview";
import { services } from "../../../api/_lib/services";

/**
 * GET/HEAD PREVIEW_ORIGIN/p/:token/*path — serves one derived preview file of the version the
 * token binds (docs/SECURITY.md §5). proxy.ts already confines `/p/*` to the preview host; the
 * host is re-checked here so a routing mistake can never serve untrusted HTML on the app origin.
 *
 * Every refusal (wrong host, bad or expired token, unsafe path, unknown file) is the same bare
 * 404, so a probe learns nothing about which part failed.
 */
const REFUSAL_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "content-security-policy": "default-src 'none'; sandbox",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const notFound = () => new Response("Not found", { status: 404, headers: REFUSAL_HEADERS });

async function serve(request: Request, withBody: boolean): Promise<Response> {
  const env = services.env();
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  if (host !== new URL(env.PREVIEW_ORIGIN).host) return notFound();

  // The raw pathname keeps percent-encoding, so segments are decoded exactly once, by us.
  const [, , token, ...rawPath] = url.pathname.split("/");
  const claims = token ? verifyPreviewToken(env.PREVIEW_TOKEN_SECRET, token) : null;
  const path = claims ? normalizePreviewPath(rawPath) : null;
  if (!claims || path === null) return notFound();

  try {
    const asset = await findPreviewFile(
      services.db(),
      { versionId: claims.v, workspaceId: claims.w },
      path,
    );
    if (!asset) return notFound();
    const headers: Record<string, string> = {
      ...previewHeaders({
        appOrigin: env.APP_ORIGIN,
        previewOrigin: env.PREVIEW_ORIGIN,
        contentType: previewContentType(path),
      }),
      etag: `"${asset.sha256}"`,
    };
    if (request.headers.get("if-none-match") === headers.etag) {
      return new Response(null, { status: 304, headers });
    }
    // HEAD never opens the object: an unconsumed stream would hold a file or socket open.
    if (!withBody) {
      return new Response(null, {
        headers: { ...headers, "content-length": String(asset.byteSize) },
      });
    }
    const { body, info } = await services.storage().getObject(asset.storageKey);
    return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
      headers: { ...headers, "content-length": String(info.size) },
    });
  } catch (error) {
    const logger = getLogger({ route: "/p" });
    if (error instanceof StorageObjectNotFoundError) {
      // The row outlived its object (e.g. a reprocess race); the integrity check reports it.
      logger.warn({ key: error.key }, "preview object missing from storage");
      return notFound();
    }
    const errorId = newErrorId();
    logger.error({ err: error, errorId }, "preview request failed");
    return new Response(`Internal error (${errorId})`, { status: 500, headers: REFUSAL_HEADERS });
  }
}

export function GET(request: Request): Promise<Response> {
  return serve(request, true);
}

export function HEAD(request: Request): Promise<Response> {
  return serve(request, false);
}
