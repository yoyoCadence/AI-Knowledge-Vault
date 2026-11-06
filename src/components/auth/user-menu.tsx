"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchOrExplain } from "@/lib/http-client";
import { t } from "@/lib/i18n";

/**
 * The signed-in address and sign-out. Only a sign-out the server confirmed leaves the page: if
 * it failed (a server error, a dropped connection), the session is still valid, so the menu
 * says so and stays, instead of going to /login (which sent the user straight back here,
 * still signed in, with nothing said).
 */
export function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setPending(true);
    setError(null);
    try {
      const response = await fetchOrExplain("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(t("auth.logoutFailed"));
      router.replace("/login");
      router.refresh();
    } catch {
      // Whatever failed, what matters here is that this device is still signed in.
      setError(t("auth.logoutFailed"));
      setPending(false);
    }
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
