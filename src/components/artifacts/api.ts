import { t } from "@/lib/i18n";

/** Calls a JSON endpoint; throws an Error whose message is ready to show the user. */
export async function jsonRequest<T>(
  url: string,
  init: { method: string; body?: unknown },
  messages: { invalid?: string; conflict?: string; gone?: string } = {},
) {
  const response = await fetch(url, {
    method: init.method,
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (response.ok) return (await response.json()) as T;
  const code = await response
    .json()
    .then((body: { error?: { code?: string } }) => body.error?.code)
    .catch(() => undefined);
  throw new Error(
    code === "VALIDATION_FAILED"
      ? (messages.invalid ?? t("edit.error.invalid"))
      : code === "CONFLICT" && messages.conflict
        ? messages.conflict
        : code === "NOT_FOUND"
          ? (messages.gone ?? t("edit.error.gone"))
          : code === "FORBIDDEN"
            ? t("edit.error.forbidden")
            : t("edit.error.generic"),
  );
}
