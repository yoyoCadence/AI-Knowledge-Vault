import { BookOpen, Download, Eye, Link2, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PreviewFrame } from "@/components/preview/preview-frame";
import { ReadingBody } from "@/components/reader/reading-body";
import { type ReaderView, ViewSwitch } from "@/components/reader/view-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getEnv } from "@/infrastructure/config/env";
import { getDb } from "@/infrastructure/database/client";
import { formatBytes, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam, type PageSearchParams } from "@/lib/search-params";
import {
  issueSharePreviewUrl,
  recordShareAccess,
  shareContent,
  shareThumbnail,
  shareVersion,
} from "@/modules/sharing";
import { accessShare } from "../_lib/access";

/**
 * GET /s/:token — the public reader of a share link (FR-SHR, docs/SECURITY.md §7). It shows only
 * what the link allows, of the artifact's current version: reading mode, the sandboxed preview
 * (with a share-scoped token), the original's download. Nothing else of the workspace (notes,
 * tags, collections, other versions) is read. No session is used, so it looks the same to
 * everyone; every failure is the same 404.
 */

/** One resolution per request: metadata and page share it (and count one view, not two). */
const load = cache(async (token: string) => {
  const access = await accessShare(await headers(), token);
  if (!access.ok) return access;
  const { capability } = access;
  const db = getDb();
  await recordShareAccess(db, capability.linkId);
  const version = await shareVersion(db, capability);
  const preview = version ? await issueSharePreviewUrl(db, capability, version, getEnv()) : null;
  // An image's own view is its thumbnail, so "reading" or "preview" both show it.
  const thumbnail =
    version?.contentKind === "image" && (capability.allowReading || capability.allowPreview)
      ? await shareThumbnail(db, capability)
      : null;
  return { ok: true as const, capability, version, preview, hasThumbnail: Boolean(thumbnail) };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const loaded = await load((await params).token);
  return {
    // `absolute`: the app name in the title template would say where this came from.
    title: {
      absolute: loaded.ok
        ? loaded.capability.title
        : loaded.reason === "rate_limited"
          ? t("share.public.rateLimited.title")
          : t("state.notFound.title"),
    },
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function SharedArtifactPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const { token } = await params;
  const loaded = await load(token);
  if (!loaded.ok) {
    if (loaded.reason === "not_found") notFound();
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-xl font-semibold">{t("share.public.rateLimited.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("share.public.rateLimited.body")}</p>
      </main>
    );
  }
  const { capability, version, preview, hasThumbnail } = loaded;

  const views: ReaderView[] = [];
  if (preview) views.push("preview");
  const imageView = version?.contentKind === "image" && hasThumbnail;
  if (version && (capability.allowReading || imageView)) views.unshift("read");
  const requested = firstParam((await searchParams).view);
  const view: ReaderView | null =
    requested === "read" || requested === "preview"
      ? views.includes(requested)
        ? requested
        : (views[0] ?? null)
      : // A site with a preview opens on it, as it does for members.
        preview
        ? "preview"
        : (views[0] ?? null);
  const content =
    view === "read" && version ? await shareContent(getDb(), capability, version) : null;
  const base = `/s/${encodeURIComponent(token)}`;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <Link2 aria-hidden />
            {t("share.public.badge")}
          </Badge>
          {capability.expiresAt ? (
            <span className="text-muted-foreground text-xs">
              {t("share.public.expires", { date: formatDateTime(capability.expiresAt) })}
            </span>
          ) : null}
        </div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight break-words sm:text-3xl">
          {capability.title}
        </h1>
        {capability.summary ? (
          <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">
            {capability.summary}
          </p>
        ) : null}
      </header>

      {version && view ? (
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
            {views.length > 1 ? <ViewSwitch view={view} views={views} /> : null}
          </CardHeader>
          <CardContent>
            {view === "read" ? (
              <ReadingBody
                thumbnailSrc={`${base}/thumbnail`}
                title={capability.title}
                version={version}
                hasThumbnail={hasThumbnail}
                content={content}
              />
            ) : preview ? (
              <PreviewFrame
                mintUrl={`${base}/preview-token`}
                title={capability.title}
                initial={{
                  url: preview.url,
                  expiresAt: preview.expiresAt.toISOString(),
                  expiresInSeconds: preview.expiresInSeconds,
                }}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : !capability.allowDownload || !version ? (
        <p className="text-muted-foreground text-sm" data-testid="share-nothing">
          {t("share.public.nothing")}
        </p>
      ) : null}

      {capability.allowDownload && version ? (
        <Card>
          <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <dl className="flex min-w-0 flex-col gap-1 text-sm">
              <dt className="sr-only">{t("artifact.filename")}</dt>
              <dd className="font-medium break-words">{version.originalFilename}</dd>
              <dt className="sr-only">{t("artifact.size")}</dt>
              <dd className="text-muted-foreground text-xs">{formatBytes(version.byteSize)}</dd>
              <dt className="sr-only">{t("artifact.sha256")}</dt>
              <dd className="text-muted-foreground flex items-start gap-1 font-mono text-xs">
                <ShieldCheck className="text-success mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-all">SHA-256 {version.sha256}</span>
              </dd>
            </dl>
            <Button asChild className="w-fit shrink-0">
              <a href={`${base}/download`} rel="noreferrer" data-testid="share-download">
                <Download />
                {t("artifact.download")}
              </a>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <footer className="text-muted-foreground border-border border-t pt-4 text-xs">
        {t("share.public.notice")} · {t("app.name")}
      </footer>
      {/* Decoration of the archive skin (docs/THEME.md); nothing in the plain one. */}
      <div aria-hidden data-slot="scene" className="hidden" />
    </main>
  );
}
