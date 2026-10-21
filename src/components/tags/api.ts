import { t } from "@/lib/i18n";

/** Calls a tag endpoint; throws an Error whose message is ready to show the user. */
export async function tagRequest<T>(url: string, init: { method: string; body?: unknown }) {
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
      ? t("tags.error.invalid")
      : code === "CONFLICT"
        ? t("tags.error.conflict")
        : code === "NOT_FOUND"
          ? t("tags.error.gone")
          : t("tags.error.generic"),
  );
}
