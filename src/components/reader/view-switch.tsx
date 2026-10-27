import Link from "next/link";
import { t } from "@/lib/i18n";

export type ReaderView = "read" | "preview";

/** Reading mode / preview tabs; only the views given are offered. */
export function ViewSwitch({
  view,
  views = ["read", "preview"],
}: {
  view: ReaderView;
  views?: ReaderView[];
}) {
  const text: Record<ReaderView, string> = {
    read: t("reader.tabRead"),
    preview: t("reader.tabPreview"),
  };
  return (
    <nav
      aria-label={t("reader.title")}
      className="border-border flex w-fit gap-1 rounded-md border p-0.5 text-sm"
    >
      {views.map((value) => (
        <Link
          key={value}
          href={`?view=${value}`}
          aria-current={view === value ? "page" : undefined}
          className={`rounded px-3 py-1 ${view === value ? "bg-surface-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
        >
          {text[value]}
        </Link>
      ))}
    </nav>
  );
}
