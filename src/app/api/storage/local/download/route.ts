import { Readable } from "node:stream";
import {
  contentDisposition,
  LocalStorageAdapter,
  StorageObjectNotFoundError,
} from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import { errorResponse } from "../../../_lib/http";
import { services } from "../../../_lib/services";

/**
 * GET /api/storage/local/download?token=… — signed, short-lived download for the local storage
 * driver. Always an attachment, never rendered inline on the app origin (SECURITY.md §5).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const storage = services.storage();
    if (!(storage instanceof LocalStorageAdapter)) return new Response(null, { status: 404 });
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const verified = storage.verifyDownloadToken(token);
    if (!verified.ok) throw new AppError("FORBIDDEN", "Download URL is invalid or expired");

    const { body, info } = await storage.getObject(verified.claims.key);
    return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(info.size),
        "content-disposition": verified.claims.fn
          ? contentDisposition(verified.claims.fn)
          : "attachment",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) return new Response(null, { status: 404 });
    return errorResponse(error, { route: "storage.local.download" });
  }
}
