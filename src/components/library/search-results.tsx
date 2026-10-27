import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/i18n";
import type { SearchHit } from "@/modules/search";
import { label } from "./artifact-card";
import { KindIcon } from "./kind-icon";

/** Search results with highlighted snippets. Segments are rendered as text, never as HTML. */
export function SearchResults({ items }: { items: SearchHit[] }) {
  return (
    <ol className="flex flex-col gap-3" data-testid="search-results">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={`/artifacts/${item.id}?view=read`}
            className="border-border bg-surface hover:border-border-strong focus-visible:ring-ring flex flex-col gap-2 rounded-lg border p-4 transition-colors focus-visible:ring-2"
          >
            <span className="flex flex-wrap items-center gap-2">
              {item.contentKind ? (
                <Badge variant="outline">
                  <KindIcon kind={item.contentKind} />
                  {label("kind", item.contentKind)}
                </Badge>
              ) : null}
              <span className="min-w-0 font-medium break-words">{item.title}</span>
            </span>
            {item.snippet ? (
              <span
                className="text-muted-foreground text-sm leading-relaxed break-words"
                data-testid="snippet"
              >
                {item.snippet.truncatedStart ? "…" : ""}
                {item.snippet.segments.map((segment, index) =>
                  segment.highlight ? (
                    <mark key={index} className="bg-accent text-accent-foreground rounded px-0.5">
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  ),
                )}
                {item.snippet.truncatedEnd ? "…" : ""}
              </span>
            ) : (
              <span className="text-muted-foreground text-sm">{t("library.noSummary")}</span>
            )}
          </Link>
        </li>
      ))}
    </ol>
  );
}
