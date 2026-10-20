import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/app/_lib/session";
import { LoginForm } from "@/components/auth/login-form";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("auth.login.title") };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await getCurrentActor()) redirect("/");
  const { next } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="border-border bg-surface w-full max-w-sm rounded-xl border p-8 shadow-sm">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {t("app.name")}
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{t("auth.login.title")}</h1>
        <p className="text-muted-foreground mt-1 mb-6 text-sm">{t("auth.login.subtitle")}</p>
        <LoginForm next={next ?? null} />
        <p className="text-muted-foreground mt-6 text-xs leading-relaxed">{t("auth.noSignup")}</p>
      </div>
    </main>
  );
}
