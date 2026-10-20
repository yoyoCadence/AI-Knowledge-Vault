import { Clock } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/i18n";

/**
 * Honest placeholder for not-yet-implemented areas (NFR-UX-2): describes the planned capability,
 * offers no controls that pretend to work.
 */
export function FutureFeature({
  title,
  phase,
  summary,
  bullets,
}: {
  title: string;
  phase: string;
  summary: string;
  bullets: string[];
}) {
  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Badge variant="warning" className="w-fit">
          <Clock aria-hidden />
          {t("future.badge")}
        </Badge>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">{t("future.body")}</p>
      </header>
      <div className="border-border bg-surface rounded-lg border p-5">
        <p className="text-sm">
          <span className="font-medium">{t("future.phase")}：</span>
          {phase}
        </p>
        <p className="mt-3 text-sm leading-relaxed">{summary}</p>
        <ul className="text-muted-foreground mt-3 list-disc space-y-1 pl-5 text-sm">
          {bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      </div>
      <Link href="/" className="text-primary text-sm underline-offset-4 hover:underline">
        {t("state.backHome")}
      </Link>
    </section>
  );
}
