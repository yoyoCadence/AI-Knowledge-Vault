import Link from "next/link";
import { t } from "@/lib/i18n";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold">{t("state.notFound.title")}</h1>
      <p className="text-muted-foreground text-sm">{t("state.notFound.body")}</p>
      <Link href="/" className="text-primary text-sm underline-offset-4 hover:underline">
        {t("state.backHome")}
      </Link>
    </main>
  );
}
