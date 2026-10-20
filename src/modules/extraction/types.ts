import type {
  ContentKind,
  ExtractionStatus,
  PreviewKind,
  ReferenceSource,
} from "@/infrastructure/database/schema";

export interface SectionDraft {
  ordinal: number;
  /** 1–6 for headings; 0 for the preamble before the first heading. */
  level: number;
  heading: string | null;
  anchor: string;
  charStart: number;
  charEnd: number;
}

/** Facts read from the file itself. Never guessed (IMPORT_PIPELINE §7): unknown stays undefined. */
export interface SourceMetadata {
  sourcePlatform?: string;
  sourceModel?: string;
  researchDate?: string;
  author?: string;
  description?: string;
  sourceUrl?: string;
}

export interface ExtractionResult {
  method: "html" | "markdown" | "text" | "pdf" | "image" | "archive";
  version: number;
  status: ExtractionStatus;
  title: string | null;
  language: string | null;
  plainText: string;
  markdown: string;
  sections: SectionDraft[];
  metadata: SourceMetadata;
  references: ReferenceSource[];
  warnings: string[];
  errorCode?: string;
  errorMessage?: string;
}

/** Classification used to fill artifact_versions.content_kind / preview_kind. */
export interface Classification {
  contentKind: ContentKind;
  previewKind: PreviewKind;
  previewEntryPath: string | null;
  analysis: Record<string, unknown>;
}
