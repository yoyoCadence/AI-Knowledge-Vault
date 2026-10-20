import { ArrowLeft, BookOpen, Download, Eye, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageActor } from "@/app/_lib/session";
import { label } from "@/components/library/artifact-card";
import { KindIcon } from "@/components/library/kind-icon";
import { PreviewFrame } from "@/components/preview/preview-frame";
import { headingAnchors, MarkdownView, PlainTextView } from "@/components/reader/markdown-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getEnv } from "@/infrastructure/config/env";
import { getDb } from "@/infrastructure/database/client";
import { isAppError } from "@/lib/errors";
import { formatBytes, formatDate, formatDateTime } from "@/lib/format";
import { isUuid } from "@/lib/ids";
import { t, tOptional } from "@/lib/i18n";
import {
  getArtifactDetail,
  getVersionContent,
  getVersionOverview,
  type VersionContent,
} from "@/modules/artifacts";
import { issuePreviewUrl } from "@/modules/preview";

type View = "read" | "preview";

async function load(id: string, requested?: string) {
  const actor = await requirePageActor();
  if (!isUuid(id)) notFound();
  try {
    const detail = await getArtifactDetail(getDb(), actor, id);
    const currentId = detail.artifact.currentVersionId ?? detail.versions[0]?.id;
    const overview = currentId ? await getVersionOverview(getDb(), actor, id, currentId) : null;
    const preview = currentId
      ? await issuePreviewUrl(getDb(), actor, { artifactId: id, versionId: currentId }, getEnv())
      : null;
    // A site with a preview opens on it; everything else opens in reading mode.
    const view: View =
      requested === "read" || requested === "preview" ? requested : preview ? "preview" : "read";
    const content =
      currentId && view === "read" ? await getVersionContent(getDb(), actor, id, currentId) : null;
    return { ...detail, overview, preview, view, content };
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { artifact } = await load(id, "preview");
  return { title: artifact.title };
}

/** Why there is no preview, in the user's terms (the original is always downloadable). */
function previewNotice(version: { previewKind: string; previewStatus: string }): string {
  if (version.previewStatus === "pending") return t("preview.pending");
  if (version.previewStatus === "failed") return t("preview.failed");
  if (version.previewKind === "framework_source") return t("preview.framework");
  // PDF, image and text versions are shown by reading mode, not this frame.
  if (["pdf", "image", "text_only"].includes(version.previewKind)) return t("preview.notYet");
  return t("preview.unavailable");
}

/** Reading mode for the current version: rendered from its extraction, never its raw HTML. */
function ReadingBody({
  artifactId,
  title,
  version,
  content,
}: {
  artifactId: string;
  title: string;
  version: { contentKind: string; processingStatus: string };
  content: VersionContent | null;
}) {
  const note = (text: string) => <p className="text-muted-foreground mb-4 text-xs">{text}</p>;
  if (version.contentKind === "image") {
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
    const busy = ["pending", "processing"].includes(version.processingStatus);
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

function ViewSwitch({ view }: { view: View }) {
  const tab = (value: View, text: string) => (
    <Link
      href={`?view=${value}`}
      aria-current={view === value ? "page" : undefined}
      className={`rounded px-3 py-1 ${view === value ? "bg-surface-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
    >
      {text}
    </Link>
  );
  return (
    <nav
      aria-label={t("reader.title")}
      className="border-border flex w-fit gap-1 rounded-md border p-0.5 text-sm"
    >
      {tab("read", t("reader.tabRead"))}
      {tab("preview", t("reader.tabPreview"))}
    </nav>
  );
}

function Field({ name, value }: { name: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{name}</dt>
      <dd className="text-sm break-words">{value}</dd>
    </div>
  );
}

export default async function ArtifactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { id } = await params;
  const { view: requested } = await searchParams;
  const { artifact, versions, overview, preview, view, content } = await load(id, requested);
  const version = overview?.version;
  const unknown = <span className="text-muted-foreground">{t("artifact.unknown")}</span>;
  const warnings = [...(overview?.extraction?.warnings ?? [])];
  if (overview?.extraction?.errorCode)
    warnings.unshift(`${overview.extraction.errorCode}: ${overview.extraction.errorMessage ?? ""}`);

  return (
    <article className="flex flex-col gap-6">
      <Link
        href="/"
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("artifact.back")}
      </Link>

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {version ? (
            <Badge>
              <KindIcon kind={version.contentKind} />
              {label("kind", version.contentKind)}
            </Badge>
          ) : null}
          <Badge variant="outline">{label("visibility", artifact.visibility)}</Badge>
          {versions.length > 1 ? (
            <Badge variant="outline">{t("library.versions", { count: versions.length })}</Badge>
          ) : null}
        </div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight sm:text-3xl">
          {artifact.title}
        </h1>
        {artifact.summary ? (
          <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">
            {artifact.summary}
          </p>
        ) : null}
        {version ? (
          <Button asChild className="w-fit lg:hidden">
            <a href={`/api/artifacts/${artifact.id}/versions/${version.id}/original`}>
              <Download />
              {t("artifact.download")}
            </a>
          </Button>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          {version ? (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  {view === "read" ? (
                    <BookOpen className="size-4" aria-hidden />
                  ) : (
                    <Eye className="size-4" aria-hidden />
                  )}
                  {view === "read" ? t("reader.title") : t("preview.title")}
                </CardTitle>
                <ViewSwitch view={view} />
              </CardHeader>
              <CardContent>
                {view === "read" ? (
                  <ReadingBody
                    artifactId={artifact.id}
                    title={artifact.title}
                    version={version}
                    content={content}
                  />
                ) : preview ? (
                  <PreviewFrame
                    artifactId={artifact.id}
                    versionId={version.id}
                    title={artifact.title}
                    initial={{
                      url: preview.url,
                      expiresAt: preview.expiresAt.toISOString(),
                      expiresInSeconds: preview.expiresInSeconds,
                    }}
                  />
                ) : (
                  <p className="text-muted-foreground text-sm" data-testid="preview-notice">
                    {previewNotice(version)}
                  </p>
                )}
              </CardContent>
            </Card>
          ) : null}

          {overview && overview.outline.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>目錄</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="flex flex-col gap-1 text-sm">
                  {overview.outline.map((section) => (
                    <li
                      key={section.anchor}
                      style={{ paddingLeft: `${Math.max(0, section.level - 1) * 0.9}rem` }}
                    >
                      <a
                        href={`?view=read#${encodeURIComponent(section.anchor)}`}
                        className="hover:text-primary hover:underline"
                      >
                        {section.heading}
                      </a>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : null}

          {version && version.referenceSources.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("artifact.references")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
                  {version.referenceSources.map((reference) => (
                    <li key={reference.url} className="break-words">
                      <a
                        href={reference.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-primary hover:underline"
                      >
                        {reference.title ?? reference.url}
                      </a>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : null}

          {warnings.length > 0 ? (
            <details className="border-border bg-surface rounded-lg border p-4 text-sm">
              <summary className="cursor-pointer font-medium">{t("artifact.warnings")}</summary>
              <ul className="text-muted-foreground mt-3 flex flex-col gap-1 font-mono text-xs">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4">
          {overview && version ? (
            <Card>
              <CardContent className="flex flex-col gap-4 pt-5">
                <Button asChild>
                  <a href={`/api/artifacts/${artifact.id}/versions/${version.id}/original`}>
                    <Download />
                    {t("artifact.download")}
                  </a>
                </Button>
                <dl className="flex flex-col gap-3">
                  <Field name={t("artifact.filename")} value={overview.file.originalFilename} />
                  <Field name={t("artifact.size")} value={formatBytes(overview.file.byteSize)} />
                  <Field
                    name={t("artifact.sha256")}
                    value={
                      <span className="flex items-start gap-1 font-mono text-xs">
                        <ShieldCheck
                          className="text-success mt-0.5 size-3.5 shrink-0"
                          aria-hidden
                        />
                        <span className="min-w-0 break-all">{overview.file.sha256}</span>
                      </span>
                    }
                  />
                  <Field
                    name={t("artifact.processing")}
                    value={
                      tOptional(`artifact.processing.${version.processingStatus}`) ??
                      version.processingStatus
                    }
                  />
                </dl>
              </CardContent>
            </Card>
          ) : null}

          {version ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("artifact.source")}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="flex flex-col gap-3">
                  <Field
                    name={t("artifact.sourcePlatform")}
                    value={
                      version.sourcePlatform ? label("platform", version.sourcePlatform) : unknown
                    }
                  />
                  <Field name={t("artifact.sourceModel")} value={version.sourceModel ?? unknown} />
                  <Field
                    name={t("artifact.researchDate")}
                    value={version.researchDate ?? unknown}
                  />
                  <Field name={t("artifact.author")} value={version.author ?? unknown} />
                  <Field
                    name={t("artifact.importedAt")}
                    value={formatDateTime(version.createdAt)}
                  />
                </dl>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t("artifact.versions")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2">
                {versions.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">
                        {t("artifact.version", { number: item.versionNumber })}
                        {item.id === artifact.currentVersionId ? (
                          <Badge variant="accent" className="ml-2">
                            {t("artifact.current")}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {formatDate(item.createdAt)} · {item.originalFilename}
                      </span>
                    </span>
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("artifact.download")} V${item.versionNumber}`}
                    >
                      <a href={`/api/artifacts/${artifact.id}/versions/${item.id}/original`}>
                        <Download />
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </aside>
      </div>
    </article>
  );
}
