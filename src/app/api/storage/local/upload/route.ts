import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { LocalStorageAdapter } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import { errorResponse, json } from "../../../_lib/http";
import { services } from "../../../_lib/services";

/**
 * PUT /api/storage/local/upload?token=… — direct upload target for the local storage driver
 * (ADR-006). Authorized solely by the HMAC token, which binds key, exact length and expiry; the
 * body is byte-capped while streaming so a client cannot write more than it declared.
 */
export async function PUT(request: Request): Promise<Response> {
  try {
    const storage = services.storage();
    if (!(storage instanceof LocalStorageAdapter)) return new Response(null, { status: 404 });
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const verified = storage.verifyUploadToken(token);
    if (!verified.ok) throw new AppError("FORBIDDEN", "Upload URL is invalid or expired");
    const { key, len, ct } = verified.claims;

    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) !== len) {
      throw new AppError("SIZE_MISMATCH", "Content-Length does not match the authorized size");
    }
    if (!request.body) throw new AppError("VALIDATION_FAILED", "Missing request body");

    // Pull-based (lazy) byte cap: nothing flows until storage consumes it, so the size error
    // surfaces through the consumer instead of as an unhandled stream error.
    const source = Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>);
    async function* capped() {
      let received = 0;
      for await (const chunk of source) {
        received += (chunk as Buffer).length;
        if (received > len)
          throw new AppError("PAYLOAD_TOO_LARGE", "Body exceeds the authorized size");
        yield chunk as Buffer;
      }
    }
    const body = Readable.from(capped());
    await storage.putObject(key, body, { contentLength: len, ...(ct ? { contentType: ct } : {}) });
    return json({ ok: true });
  } catch (error) {
    if (error instanceof Error && /content length mismatch/.test(error.message)) {
      return errorResponse(
        new AppError("SIZE_MISMATCH", "Uploaded size does not match the authorized size"),
      );
    }
    return errorResponse(error, { route: "storage.local.upload" });
  }
}
