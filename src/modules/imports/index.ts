export {
  createBatch,
  declareItem,
  completeItem,
  retryItem,
  cancelItem,
  getBatchReport,
  listBatches,
  auditBatchCreated,
  refreshBatchStatus,
  transitionItem,
  IMPORT_JOB_TYPE,
  importJobKey,
  type ImportLimits,
  type BatchReport,
} from "./service";
export {
  importJobDefinition,
  processImportItem,
  deterministicId,
  type ProcessLimits,
} from "./process-item";
export {
  CreateBatchInput,
  DeclareItemInput,
  ALLOWED_EXTENSIONS,
  sanitizeFilename,
} from "./validation";
export { canTransition, isTerminal, TERMINAL_STATUSES } from "./state";

import type { Env } from "@/infrastructure/config/env";
import type { ImportLimits } from "./service";
import type { ProcessLimits } from "./process-item";

export function importLimitsFromEnv(env: Env): ImportLimits {
  return {
    maxFileBytes: env.IMPORT_MAX_FILE_BYTES,
    maxItemsPerBatch: env.IMPORT_MAX_ITEMS_PER_BATCH,
    uploadUrlTtlSeconds: env.UPLOAD_URL_TTL_SECONDS,
  };
}

export function processLimitsFromEnv(env: Env): ProcessLimits {
  return {
    maxFileBytes: env.IMPORT_MAX_FILE_BYTES,
    maxExtractBytes: env.EXTRACT_MAX_BYTES,
    pdfMaxPages: env.PDF_MAX_PAGES,
    imageMaxInputPixels: env.IMAGE_MAX_INPUT_PIXELS,
    maxEntries: env.ZIP_MAX_ENTRIES,
    maxTotalUncompressedBytes: env.ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
    maxEntryBytes: env.ZIP_MAX_ENTRY_BYTES,
    maxCompressionRatio: env.ZIP_MAX_COMPRESSION_RATIO,
    maxPathDepth: env.ZIP_MAX_PATH_DEPTH,
    maxPreviewFiles: env.PREVIEW_MAX_FILES,
    maxPreviewBytes: env.PREVIEW_MAX_TOTAL_BYTES,
  };
}
export { toItemDto, toBatchDto } from "./dto";
export {
  cleanupImports,
  importCleanupJobDefinition,
  IMPORT_CLEANUP_JOB_TYPE,
  type CleanupOptions,
  type CleanupReport,
} from "./maintenance";
