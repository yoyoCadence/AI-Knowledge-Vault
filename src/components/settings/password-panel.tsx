"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchOrExplain, signedOutMessage } from "@/lib/http-client";
import { t } from "@/lib/i18n";

const field =
  "border-border-strong bg-surface focus-visible:ring-ring h-9 w-full max-w-sm rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none";

/**
 * Changes the signed-in user's password (Better Auth's `/change-password`). The server signs out
 * every other device and audits the change (auth.ts hooks); this device stays signed in with a
 * new session, so the session list is refreshed afterwards.
 */
export function PasswordPanel({ minLength, maxLength }: { minLength: number; maxLength: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    setError(null);
    setDone(false);
    if (newPassword !== String(data.get("confirmPassword") ?? "")) {
      setError(t("password.error.mismatch"));
      return;
    }
    if (newPassword.length < minLength || newPassword.length > maxLength) {
      setError(t("password.error.length", { min: minLength, max: maxLength }));
      return;
    }
    setBusy(true);
    try {
      const response = await fetchOrExplain("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
      });
      if (!response.ok) {
        const code = await response
          .json()
          .then((body: { code?: string }) => body.code)
          .catch(() => undefined);
        throw new Error(
          signedOutMessage(response) ??
            (response.status === 429
              ? t("password.error.tooMany")
              : code === "INVALID_PASSWORD"
                ? t("password.error.current")
                : code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG"
                  ? t("password.error.length", { min: minLength, max: maxLength })
                  : t("password.error.generic")),
        );
      }
      form.reset();
      setDone(true);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("password.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="password-panel">
      <label className="flex flex-col gap-1 text-sm">
        {t("password.current")}
        <input
          type="password"
          name="currentPassword"
          autoComplete="current-password"
          required
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t("password.new", { min: minLength })}
        <input
          type="password"
          name="newPassword"
          autoComplete="new-password"
          required
          minLength={minLength}
          maxLength={maxLength}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t("password.confirm")}
        <input
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          required
          maxLength={maxLength}
          className={field}
        />
      </label>
      <Button type="submit" size="sm" className="w-fit" disabled={busy}>
        {t("password.submit")}
      </Button>
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm" data-testid="password-done">
          {t("password.done")}
        </p>
      ) : null}
    </form>
  );
}
