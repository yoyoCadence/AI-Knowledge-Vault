import { t } from "@/lib/i18n";
import type { VersionContent } from "@/modules/artifacts";
import { headingAnchors, MarkdownView, PlainTextView } from "./markdown-view";

/** Reading mode for a version: rendered from its extraction, never from its raw HTML. */
export function ReadingBody({
  artifactId,
  title,
  version,
  hasThumbnail,
  content,
}: {
  artifactId: string;
  title: string;
  version: { contentKind: string; processingStatus: string };
  /** Whether the version's thumbnail exists (a restored image gets it only after re-extraction). */
  hasThumbnail: boolean;
  content: VersionContent | null;
}) {
  const note = (text: string) => <p className="text-muted-foreground mb-4 text-xs">{text}</p>;
  const busy = ["pending", "processing"].includes(version.processingStatus);
  if (version.contentKind === "image") {
    if (!hasThumbnail) {
      return (
        <p className="text-muted-foreground text-sm" data-testid="reader-empty">
          {busy ? t("reader.pending") : t("reader.imageMissing")}
        </p>
      );
    }
    return (
      <figure className="flex flex-col gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- authorized same-origin image route, not optimizable */}
        <img
          src={`/api/artifacts/${artifactId}/thumbnail`}
          alt={title}
          className="border-border max-h-[70vh] w-fit max-w-full rounded-md border object-contain"
        />
        <figcaption>{note(t("reader.imageNote"))}</figcaption>
      </figure>
    );
  }
  if (!content || !content.extraction.markdown.trim()) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="reader-empty">
        {busy ? t("reader.pending") : t("reader.empty")}
      </p>
    );
  }
  const { method, markdown } = content.extraction;
  return (
    <div data-testid="reader">
      {note(
        method === "pdf"
          ? t("reader.pdfNote")
          : method === "restore_archive"
            ? t("reader.restored")
            : t("reader.source"),
      )}
      {method === "text" ? (
        <PlainTextView text={markdown} />
      ) : (
        <MarkdownView markdown={markdown} anchors={headingAnchors(content.sections)} />
      )}
    </div>
  );
}
