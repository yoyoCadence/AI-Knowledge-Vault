"use client";

import { Monitor } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export interface SessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

const formatter = new Intl.DateTimeFormat("zh-TW", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Taipei",
});

function describeAgent(userAgent: string | null): string {
  if (!userAgent) return t("sessions.unknownDevice");
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return [browser, os].filter(Boolean).join(" · ") || t("sessions.unknownDevice");
}

export function SessionsPanel({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(id: string, url: string, method: "DELETE" | "POST") {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      if (!response.ok) throw new Error(String(response.status));
      router.refresh();
    } catch {
      setError(t("sessions.error"));
    } finally {
      setBusy(null);
    }
  }

  const others = sessions.filter((session) => !session.current).length;

  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-border border-border bg-surface divide-y rounded-lg border">
        {sessions.map((session) => (
          <li key={session.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Monitor aria-hidden className="text-muted-foreground size-4" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {describeAgent(session.userAgent)}
                {session.current ? <Badge variant="accent">{t("sessions.current")}</Badge> : null}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("sessions.createdAt")} {formatter.format(new Date(session.createdAt))} ·{" "}
                {t("sessions.expiresAt")} {formatter.format(new Date(session.expiresAt))}
                {session.ipAddress ? ` · ${t("sessions.ip")} ${session.ipAddress}` : ""}
              </p>
            </div>
            {!session.current ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => call(session.id, `/api/sessions/${session.id}`, "DELETE")}
              >
                {t("sessions.revoke")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {others > 0 ? (
        <Button
          variant="danger"
          size="sm"
          className="w-fit"
          disabled={busy !== null}
          onClick={() => call("others", "/api/sessions/revoke-others", "POST")}
        >
          {t("sessions.revokeOthers")}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
