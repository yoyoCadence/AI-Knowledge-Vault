import { zhTW, type MessageKey } from "./messages/zh-TW";

/**
 * Minimal typed i18n (ADR-016). Phase 1 resolves to zh-TW only; replacing this function
 * with a full i18n library later does not change call sites.
 */
export const DEFAULT_LOCALE = "zh-TW";
export type Locale = typeof DEFAULT_LOCALE;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { "zh-TW": zhTW };

export function t(
  key: MessageKey,
  params?: Record<string, string | number>,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const template = dictionaries[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Translates a dynamic key (e.g. `kind.${value}`), or returns null when no message exists. */
export function tOptional(key: string, locale: Locale = DEFAULT_LOCALE): string | null {
  const dictionary = dictionaries[locale] as Record<string, string>;
  return Object.hasOwn(dictionary, key) ? dictionary[key]! : null;
}

export type { MessageKey };
