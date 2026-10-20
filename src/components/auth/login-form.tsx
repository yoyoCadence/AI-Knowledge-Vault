"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/** Only same-site relative paths are allowed as post-login destinations (no open redirect). */
function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\"))
    return "/";
  return value;
}

export function LoginForm({ next }: { next: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          rememberMe: true,
        }),
      });
      if (response.ok) {
        window.location.assign(safeNext(next));
        return;
      }
      setError(
        response.status === 429
          ? t("auth.error.rateLimited")
          : response.status === 401 || response.status === 400
            ? t("auth.error.invalid")
            : t("auth.error.generic"),
      );
    } catch {
      setError(t("auth.error.generic"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">{t("auth.email")}</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className="border-border-strong bg-surface focus-visible:ring-ring h-10 rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">{t("auth.password")}</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="border-border-strong bg-surface focus-visible:ring-ring h-10 rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
        />
      </label>
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="mt-2 h-10">
        {pending ? t("auth.submitting") : t("auth.submit")}
      </Button>
    </form>
  );
}
