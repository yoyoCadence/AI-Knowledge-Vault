import { z } from "zod";
import { contentDisposition } from "@/infrastructure/storage";
import { AppError, notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { encryptionOptions, openEncryptedExport } from "@/modules/backup";
import { parseJsonBody } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

const Body = z
  .object({
    passphrase: z.string().max(4_096).optional(),
    recipients: z.array(z.string().max(1_000)).max(50).optional(),
  })
  .strict();

/**
 * The owner's choice, from JSON or from the export panel's plain form POST (a form lets the
 * browser stream the download straight to disk). Recipients in a form are one per line.
 */
async function readChoice(request: Request) {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type.startsWith("application/json")) return parseJsonBody(request, Body);
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Expected a form or application/json");
  }
  const form = await request.formData();
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value.length <= 10_000 ? value : undefined;
  };
  return { passphrase: field("passphrase"), recipients: field("recipients")?.split(/\s+/) };
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
