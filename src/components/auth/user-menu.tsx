"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        className="text-muted-foreground truncate text-xs"
        title={t("auth.signedInAs", { email })}
      >
        {email}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("auth.logout")}
        title={t("auth.logout")}
        disabled={pending}
        onClick={logout}
      >
        <LogOut />
      </Button>
    </div>
  );
}
