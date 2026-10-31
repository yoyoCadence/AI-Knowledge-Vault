"use client";

import { Palette } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { DEFAULT_SKIN, SKIN_COOKIE, skinOf, type Skin } from "@/lib/skin";

const YEAR_SECONDS = 365 * 24 * 60 * 60;

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
  return () => observer.disconnect();
}

/**
 * Switches between the reading-room skin and the plain one. The choice applies at once (the
 * skin is CSS on `<html data-skin>`) and stays for this browser in a cookie, which the root
 * layout reads on the next request.
 */
export function SkinToggle() {
  const current = useSyncExternalStore(
    subscribe,
    () => skinOf(document.documentElement.dataset.skin),
    () => null,
  );
  const shown: Skin = current ?? DEFAULT_SKIN;
  const next: Skin = shown === "archive" ? "plain" : "archive";
  const label = `${t("skin.toggle")}（${t(`skin.${shown}`)}）`;

  function choose() {
    document.documentElement.dataset.skin = next;
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${SKIN_COOKIE}=${next}; path=/; max-age=${YEAR_SECONDS}; samesite=lax${secure}`;
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={current ? label : t("skin.toggle")}
      title={current ? label : t("skin.toggle")}
      onClick={choose}
    >
      <Palette />
    </Button>
  );
}
