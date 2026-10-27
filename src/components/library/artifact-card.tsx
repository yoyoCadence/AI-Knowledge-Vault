import { Star } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { t, tOptional } from "@/lib/i18n";
import { KindIcon } from "./kind-icon";

export interface ArtifactCardData {
  id: string;
  title: string;
  summary: string | null;
  visibility: string;
  createdAt: string;
  versionCount: number;
  hasThumbnail: boolean;
  contentKind: string | null;
  sourcePlatform: string | null;
  sourceModel: string | null;
  /** Tag names, by name. */
  tags: string[];
  /** The viewer's own reading state. */
  readingStatus: "unread" | "reading" | "read";
  isFavorite: boolean;
}

const SHOWN_TAGS = 3;

export const label = (prefix: string, value: string) => tOptional(`${prefix}.${value}`) ?? value;

/** A work's title, starred when it is the viewer's favourite. */
function ArtifactTitle({ artifact, className }: { artifact: ArtifactCardData; className: string }) {
  return (
    <h3 className={`group-hover:text-primary text-sm font-semibold break-words ${className}`}>
      {artifact.isFavorite ? (
        <>
          <Star
            className="fill-warning text-warning mr-1 inline size-3.5 align-[-2px]"
            aria-hidden
          />
          <span className="sr-only">{t("reading.favorite")}: </span>
        </>
      ) : null}
      {artifact.title}
    </h3>
  );
}

/** Kind, source platform, the viewer's reading state and the version count. */
function ArtifactBadges({
  artifact,
  className,
}: {
  artifact: ArtifactCardData;
  className: string;
}) {
  const kind = artifact.contentKind ?? "unknown";
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <Badge>
        <KindIcon kind={kind} />
        {label("kind", kind)}
      </Badge>
      {artifact.sourcePlatform ? (
        <Badge variant="accent">{label("platform", artifact.sourcePlatform)}</Badge>
      ) : null}
      {artifact.readingStatus !== "unread" ? (
        <Badge variant="outline" data-testid="reading-badge">
          {t(`reading.status.${artifact.readingStatus}`)}
        </Badge>
      ) : null}
      {artifact.versionCount > 1 ? (
        <Badge variant="outline">{t("library.versions", { count: artifact.versionCount })}</Badge>
      ) : null}
    </div>
  );
}

/** The first few tags, and how many more there are. */
function ArtifactTags({ tags }: { tags: string[] }) {
  return tags.length > 0 ? (
    <p className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
      {tags.slice(0, SHOWN_TAGS).map((name) => (
        <span key={name} className="break-all">
          #{name}
        </span>
      ))}
      {tags.length > SHOWN_TAGS ? (
        <span>{t("tags.more", { count: tags.length - SHOWN_TAGS })}</span>
      ) : null}
    </p>
  ) : null;
}

function ArtifactDate({
  artifact,
  className = "",
}: {
  artifact: ArtifactCardData;
  className?: string;
}) {
  return (
    <p className={`text-muted-foreground text-[11px] ${className}`}>
      {formatDate(artifact.createdAt)} · {label("visibility", artifact.visibility)}
    </p>
  );
}

const linkClass =
  "group border-border bg-surface hover:border-border-strong focus-visible:ring-ring rounded-lg border transition-colors focus-visible:ring-2";

/** Library card (Master Spec §9.3). Thumbnails come from an authorized app route. */
export function ArtifactCard({ artifact }: { artifact: ArtifactCardData }) {
  const kind = artifact.contentKind ?? "unknown";
  return (
    <Link
      href={`/artifacts/${artifact.id}`}
      className={`${linkClass} flex flex-col overflow-hidden`}
    >
      <div className="bg-surface-muted relative flex aspect-[16/10] items-center justify-center">
        {artifact.hasThumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element -- authorized same-origin image route, not optimizable
          <img
            src={`/api/artifacts/${artifact.id}/thumbnail`}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <KindIcon kind={kind} className="text-muted-foreground/60 size-10" />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <ArtifactTitle artifact={artifact} className="line-clamp-2 leading-snug" />
        <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
          {artifact.summary ?? t("library.noSummary")}
        </p>
        <ArtifactBadges artifact={artifact} className="mt-auto pt-1" />
        <ArtifactTags tags={artifact.tags} />
        <ArtifactDate artifact={artifact} />
      </div>
    </Link>
  );
}

/**
 * The same work as one row of the list layout: no thumbnail or summary, so more works fit on a
 * screen. On a phone its parts stack; from `sm` up the badges and date sit beside the title.
 */
export function ArtifactRow({ artifact }: { artifact: ArtifactCardData }) {
  return (
    <Link
      href={`/artifacts/${artifact.id}`}
      data-testid="artifact-row"
      className={`${linkClass} flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <ArtifactTitle artifact={artifact} className="leading-snug" />
        <ArtifactTags tags={artifact.tags} />
      </div>
      <ArtifactBadges artifact={artifact} className="sm:justify-end" />
      <ArtifactDate artifact={artifact} className="shrink-0" />
    </Link>
  );
}
