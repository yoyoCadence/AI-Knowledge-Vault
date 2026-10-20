import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** Consistent empty state (NFR-UX-1). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border-strong flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-14 text-center",
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className="text-muted-foreground size-8" /> : null}
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? (
        <p className="text-muted-foreground max-w-md text-sm leading-relaxed">{description}</p>
      ) : null}
      {action}
    </div>
  );
}

/** Error state showing a correlatable error id instead of "Something went wrong" (§24). */
export function ErrorState({
  title,
  description,
  errorId,
  errorIdLabel,
  action,
}: {
  title: string;
  description: string;
  errorId?: string;
  errorIdLabel: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className="border-danger/40 bg-danger/5 flex flex-col items-start gap-3 rounded-lg border p-6"
    >
      <h2 className="text-danger text-base font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{description}</p>
      {errorId ? (
        <p className="text-muted-foreground text-xs">
          {errorIdLabel}: <code className="font-mono">{errorId}</code>
        </p>
      ) : null}
      {action}
    </div>
  );
}
