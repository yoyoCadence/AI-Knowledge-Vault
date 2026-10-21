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
}

const SHOWN_TAGS = 3;

export const label = (prefix: string, value: string) => tOptional(`${prefix}.${value}`) ?? value;

/** Library card (Master Spec §9.3). Thumbnails come from an authorized app route. */
export function ArtifactCard({ artifact }: { artifact: ArtifactCardData }) {
  const kind = artifact.contentKind ?? "unknown";
  return (
    <Link
      href={`/artifacts/${artifact.id}`}
      className="group border-border bg-surface hover:border-border-strong focus-visible:ring-ring flex flex-col overflow-hidden rounded-lg border transition-colors focus-visible:ring-2"
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
        <h3 className="group-hover:text-primary line-clamp-2 text-sm leading-snug font-semibold">
          {artifact.title}
        </h3>
        <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
          {artifact.summary ?? t("library.noSummary")}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <Badge>
            <KindIcon kind={kind} />
            {label("kind", kind)}
          </Badge>
          {artifact.sourcePlatform ? (
            <Badge variant="accent">{label("platform", artifact.sourcePlatform)}</Badge>
          ) : null}
          {artifact.versionCount > 1 ? (
            <Badge variant="outline">
              {t("library.versions", { count: artifact.versionCount })}
            </Badge>
          ) : null}
        </div>
        {artifact.tags.length > 0 ? (
          <p className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
            {artifact.tags.slice(0, SHOWN_TAGS).map((name) => (
              <span key={name}>#{name}</span>
            ))}
            {artifact.tags.length > SHOWN_TAGS ? (
              <span>{t("tags.more", { count: artifact.tags.length - SHOWN_TAGS })}</span>
            ) : null}
          </p>
        ) : null}
        <p className="text-muted-foreground text-[11px]">
          {formatDate(artifact.createdAt)} · {label("visibility", artifact.visibility)}
        </p>
      </div>
    </Link>
  );
}
