"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "./nav-items";
import { SkinToggle } from "./skin-toggle";
import { ThemeToggle } from "./theme-toggle";

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="size-4 shrink-0" />
            <span className="flex-1 truncate">{t(item.labelKey)}</span>
            {item.future ? <Badge className="px-1.5 text-[10px]">{t("nav.future")}</Badge> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** The sidebar's foot: who is signed in, and the look of the app. */
function ShellFooter({ userSlot }: { userSlot?: ReactNode }) {
  return (
    <>
      <div className="mt-auto flex items-center justify-between gap-2 px-1">
        {userSlot}
        <div className="flex shrink-0">
          <SkinToggle />
          <ThemeToggle />
        </div>
      </div>
      {/* Decoration of the archive skin (docs/THEME.md); nothing in the plain one. */}
      <div aria-hidden data-slot="cabinet-shelf" className="hidden" />
    </>
  );
}

/** App shell: persistent sidebar on desktop, drawer on mobile (Master Spec §18). */
export function AppShell({ children, userSlot }: { children: ReactNode; userSlot?: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-dvh">
      <aside
        data-region="cabinet"
        className="border-border bg-surface sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r px-3 py-4 lg:flex"
      >
        <Link
          href="/"
          data-slot="nameplate"
          className="mb-6 px-3 text-sm font-semibold tracking-tight"
        >
          {t("app.name")}
        </Link>
        <NavList />
        <ShellFooter userSlot={userSlot} />
      </aside>

      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label={t("nav.closeMenu")}
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div
            data-region="cabinet"
            className="bg-surface absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col px-3 py-4 shadow-xl"
          >
            <div className="mb-6 flex items-center justify-between px-3">
              <span data-slot="nameplate" className="text-sm font-semibold">
                {t("app.name")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("nav.closeMenu")}
                onClick={() => setOpen(false)}
              >
                <X />
              </Button>
            </div>
            <NavList onNavigate={() => setOpen(false)} />
            <ShellFooter userSlot={userSlot} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <div aria-hidden data-slot="cornice" className="hidden" />
        <header
          data-region="topbar"
          className="border-border bg-background/90 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur lg:hidden"
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("nav.openMenu")}
            onClick={() => setOpen(true)}
          >
            <Menu />
          </Button>
          <span data-slot="nameplate" className="text-sm font-semibold">
            {t("app.name")}
          </span>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          {children}
        </main>
        <div aria-hidden data-slot="scene" className="hidden" />
      </div>
    </div>
  );
}
