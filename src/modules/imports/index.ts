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
  };
}
export { toItemDto, toBatchDto } from "./dto";
