import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { t } from "@/lib/i18n";
import { SKIN_COOKIE, skinOf } from "@/lib/skin";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: t("app.name"), template: `%s · ${t("app.name")}` },
  description: t("app.tagline"),
  // Private knowledge base: never indexed. Public pages opt in explicitly (Phase 1B/4).
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfcfd" },
    { media: "(prefers-color-scheme: dark)", color: "#16171b" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The skin is chosen per browser (docs/THEME.md); reading it here avoids a flash of the other.
  const skin = skinOf((await cookies()).get(SKIN_COOKIE)?.value);
  return (
    <html lang="zh-Hant-TW" data-skin={skin} suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
