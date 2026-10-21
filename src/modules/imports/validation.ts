import { z } from "zod";
import { fileExtension } from "@/modules/extraction";

/** Extension allow-list at declaration time (IMPORT_PIPELINE §2). Content is re-verified by bytes. */
export const ALLOWED_EXTENSIONS = new Set([
  "html",
  "htm",
  "zip",
  "pdf",
  "md",
  "markdown",
  "txt",
  "png",
  "jpg",
  "jpeg",
  "webp",
]);

/**
 * Sanitizes a client-supplied filename for display/export (SECURITY.md §4): NFC, strip path
 * components and control characters, cap at 255 UTF-8 bytes while keeping the extension.
 */
export function sanitizeFilename(raw: string): string {
  const base = (raw.normalize("NFC").split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (!base) return "untitled";
  if (Buffer.byteLength(base, "utf8") <= 255) return base;
  const extension = fileExtension(base);
  const suffix = extension ? `.${extension}` : "";
  let stem = base.slice(0, base.length - suffix.length);
  while (Buffer.byteLength(stem + suffix, "utf8") > 255) stem = stem.slice(0, -1);
  return stem + suffix;
}

export const CreateBatchInput = z.object({
  projectId: z.uuid().optional(),
  collectionId: z.uuid().optional(),
  options: z
    .object({
      autoVersionByFilename: z.boolean().optional(),
      sourcePlatform: z.string().trim().min(1).max(100).optional(),
    })
    .optional(),
});
export type CreateBatchInput = z.infer<typeof CreateBatchInput>;

export const DeclareItemInput = z.object({
  filename: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  mimeType: z.string().max(255).optional(),
  clientKey: z.string().min(1).max(200).optional(),
  targetArtifactId: z.uuid().optional(),
});
export type DeclareItemInput = z.infer<typeof DeclareItemInput>;
