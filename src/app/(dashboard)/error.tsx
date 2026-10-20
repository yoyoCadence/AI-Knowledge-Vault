"use client";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { t } from "@/lib/i18n";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorState
      title={t("state.error.title")}
      description={t("state.error.body")}
      errorId={error.digest}
      errorIdLabel={t("state.error.id")}
      action={
        <Button variant="outline" size="sm" onClick={reset}>
          {t("state.retry")}
        </Button>
      }
    />
  );
}
