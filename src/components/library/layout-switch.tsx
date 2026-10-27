"use client";

import { LayoutGrid, List } from "lucide-react";
import { useRouter } from "next/navigation";
import { t } from "@/lib/i18n";
import { LIBRARY_LAYOUT_COOKIE, LIBRARY_LAYOUTS, type LibraryLayout } from "@/lib/library-layout";

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const icons = { grid: LayoutGrid, list: List } as const;

/** Keeps the choice in this browser for a year, for every page of the app. */
function rememberLayout(layout: LibraryLayout) {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${LIBRARY_LAYOUT_COOKIE}=${layout}; path=/; max-age=${YEAR_SECONDS}; samesite=lax${secure}`;
}

/** Switches the library between cards and rows; the choice stays for this browser. */
export function LayoutSwitch({ current }: { current: LibraryLayout }) {
  const router = useRouter();
  function choose(layout: LibraryLayout) {
    if (layout === current) return;
    rememberLayout(layout);
    router.refresh();
  }
  return (
    <div role="group" aria-label={t("library.layout")} className="flex gap-1">
      {LIBRARY_LAYOUTS.map((layout) => {
        const Icon = icons[layout];
        return (
          <button
            key={layout}
            type="button"
            aria-pressed={layout === current}
            onClick={() => choose(layout)}
            className={`focus-visible:ring-ring flex items-center gap-1 rounded-md border px-2.5 py-1 text-sm focus-visible:ring-2 focus-visible:outline-none ${layout === current ? "border-primary text-primary font-medium" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            <Icon className="size-4" aria-hidden />
            {t(`library.layout.${layout}`)}
          </button>
        );
      })}
    </div>
  );
}
