export * from "./format";
export { writeExport, currentMigrationTag, type ExportSummary } from "./export";
export {
  restoreArchive,
  REEXTRACT_JOB_TYPE,
  RESTORE_EXTRACTION_METHOD,
  type RestoreLimits,
  type RestoreReport,
} from "./restore";
export { reextractVersion, reextractJobDefinition } from "./reextract";
export {
  requestExport,
  listExports,
  createExportDownload,
  runExport,
  exportJobDefinition,
  exportCleanupJobDefinition,
  deleteExpiredExports,
  toExportDto,
  EXPORT_JOB_TYPE,
  EXPORT_CLEANUP_JOB_TYPE,
  EXPORT_RETENTION_DAYS,
  type ExportRun,
} from "./service";

import type { Env } from "@/infrastructure/config/env";
import type { RestoreLimits } from "./restore";

export function restoreLimitsFromEnv(env: Env): RestoreLimits {
  return {
    maxEntries: env.RESTORE_MAX_ENTRIES,
    maxTotalUncompressedBytes: env.RESTORE_MAX_TOTAL_BYTES,
    maxEntryBytes: Math.max(env.IMPORT_MAX_FILE_BYTES, 256 * 1024 * 1024),
    maxCompressionRatio: 1_000,
    maxPathDepth: 8,
  };
}
