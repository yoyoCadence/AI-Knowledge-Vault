import { Library } from "lucide-react";
import { EmptyState } from "@/components/ui/states";
import { t } from "@/lib/i18n";

export default function LibraryPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("library.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("app.tagline")}</p>
      </header>
      <EmptyState
        icon={Library}
        title={t("library.empty.title")}
        description={t("library.empty.body")}
      />
    </div>
  );
}
