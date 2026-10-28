import { z } from "zod";
import { contentDisposition } from "@/infrastructure/storage";
import { AppError, notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { recipientsFrom } from "@/lib/backup-encryption";
import { encryptionOptions, openEncryptedExport } from "@/modules/backup";
import { validate } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

/** A choice is a passphrase or up to ten 62-character keys: far below this. */
const BODY_MAX_BYTES = 16 * 1024;

const Body = z
  .object({
    passphrase: z.string().max(4_096).optional(),
    recipients: z.array(z.string().max(200)).max(50).optional(),
  })
  .strict();

/**
 * The request body as text, refused past BODY_MAX_BYTES: read chunk by chunk, so a body with
 * no (or a false) content-length is cut off there, not buffered whole.
 */
async function cappedText(request: Request): Promise<string> {
  const tooLarge = () => new AppError("PAYLOAD_TOO_LARGE", "Request too large");
  if (Number(request.headers.get("content-length") ?? "0") > BODY_MAX_BYTES) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > BODY_MAX_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    parts.push(read.value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/**
 * The owner's choice, from JSON or from the export panel's plain form POST (a form lets the
 * browser stream the download straight to disk). The media type must be exactly one of the
 * two; a form is parsed as URL-encoded text, never as multipart. Recipients in a form are one
 * per line.
 */
async function readChoice(request: Request) {
  const essence = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence === "application/json") {
    let raw: unknown;
    try {
      raw = JSON.parse(await cappedText(request));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("VALIDATION_FAILED", "Malformed JSON body");
    }
    return validate(Body, raw);
  }
  if (essence !== "application/x-www-form-urlencoded") {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Expected a form or application/json");
  }
  const form = new URLSearchParams(await cappedText(request));
  return {
    passphrase: form.get("passphrase") ?? undefined,
    recipients: recipientsFrom(form.get("recipients") ?? ""),
  };
}

/**
 * POST /api/exports/:id/encrypted `{passphrase}` or `{recipients: ["age1…"]}` — the archive,
 * encrypted with age while it streams (`…zip.age`, ADR-022). The secret is used for this
 * response only: never stored, logged or audited. The archive is checked against its SHA-256
 * on the way; a mismatch aborts the download before age's final chunk, so it cannot decrypt.
 */
export const POST = authedRoute<{ id: string }>(
  { permission: "backup:export" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Export");
    const choice = await readChoice(request);
    const options = encryptionOptions({
      passphrase: choice.passphrase ?? null,
      recipients: choice.recipients ?? null,
    });
    const encrypted = await openEncryptedExport(
      services.db(),
      services.storage(),
      actor,
      params.id,
      options,
      meta,
    );
    return new Response(encrypted.stream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": contentDisposition(encrypted.filename),
        "content-length": String(encrypted.byteSize),
        "cache-control": "no-store",
        "x-plaintext-sha256": encrypted.sha256,
      },
    });
  },
);
