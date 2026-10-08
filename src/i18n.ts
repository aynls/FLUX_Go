import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  baseLocale,
  locales,
  overwriteGetLocale,
} from "./paraglide/runtime";
import * as m from "./paraglide/messages.js";

export type Locale = "en" | "zh" | "ja";
export type LocalePreference = "system" | Locale;

let current: Locale = baseLocale;
overwriteGetLocale(() => current);

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function applyLocale(locale: Locale) {
  current = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang =
      locale === "zh" ? "zh-CN" : locale === "ja" ? "ja" : "en";
    document.title = m.window_title();
  }
  if (isTauri()) void getCurrentWindow().setTitle(m.window_title());
}

export function localeFromLanguage(language: string): Locale {
  const value = language.toLowerCase();
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("ja")) return "ja";
  return "en";
}

export function resolveLocale(
  preference: LocalePreference | undefined,
  language = typeof navigator === "undefined" ? "en" : navigator.language,
): Locale {
  if (preference && preference !== "system" && isLocale(preference))
    return preference;
  return localeFromLanguage(language);
}

export function activeLocale(): Locale {
  return current;
}

export function formatNumber(value: number) {
  return value.toLocaleString(current);
}

export function formatDate(value: number | Date) {
  return new Date(value).toLocaleDateString(current);
}

export function formatDateTime(value: number | Date) {
  return new Date(value).toLocaleString(current);
}

export function formatTime(value: number | Date) {
  return new Date(value).toLocaleTimeString(current);
}

type MessageFn = (inputs?: Record<string, string | number>) => string;

/** Localized catalog text, or the English fallback when the code is unknown. */
export function localizeMessage(
  code: string | undefined,
  fallback: string,
  inputs: Record<string, string | number> = {},
) {
  if (!code) return fallback;
  const fn = (m as unknown as Record<string, MessageFn>)[code];
  return typeof fn === "function" ? fn(inputs) : fallback;
}

/**
 * Text persisted or returned as a backend message code (for example a history
 * error) is localized at display time; any other text is shown unchanged.
 */
export function localizeStored(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        code?: string;
        message?: string;
        params?: Record<string, string | number>;
      };
      if (parsed.code)
        return localizeMessage(
          parsed.code,
          parsed.message || parsed.code,
          parsed.params ?? {},
        );
    } catch {
      // Ordinary text that happens to start with a brace.
    }
  }
  return /^backend_\w+$/.test(value) ? localizeMessage(value, value) : value;
}

export { m, baseLocale, locales };
