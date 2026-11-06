"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * The signed-in address and sign-out. Only a sign-out the server confirmed leaves the page,
 * instead of going to /login regardless (which sent the user straight back here, still signed
 * in, with nothing said). A server error means the session is still valid; a dropped
 * connection leaves it unknown (the server may have ended it), so the menu says which.
 */
export function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setPending(true);
    setError(null);
    let response: Response;
    try {
      response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      setError(t("auth.logoutUnconfirmed"));
      setPending(false);
      return;
    }
    if (!response.ok) {
      setError(t("auth.logoutFailed"));
      setPending(false);
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
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
      {error ? (
        <p role="alert" className="text-danger text-xs" data-testid="logout-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
