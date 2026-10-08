import { isTauri } from "@tauri-apps/api/core";
import { m } from "../i18n";
import { openUrl } from "@tauri-apps/plugin-opener";

export function webUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export async function openWebUrl(value: string) {
  const url = webUrl(value);
  if (!url) throw new Error(m.error_bad_source_url());
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
