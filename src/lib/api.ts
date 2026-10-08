// Tauri 后端命令的类型化封装与错误解析。

import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { localizeMessage, localizeStored, m } from "../i18n";
import { listen } from "@tauri-apps/api/event";
import type { GenerationProgress } from "./types";
import type {
  GenerateOutput,
  GenerateRequestPayload,
  HistoryItem,
  ProviderStatus,
} from "./types";
import type {
  Draft,
  WorkspaceSession,
  ProviderId,
  CredentialSettings,
  GalleryItem,
} from "./types";

export class AppError extends Error {
  status?: number;
  hint?: string;

  constructor(message: string, opts?: { status?: number; hint?: string }) {
    super(message);
    this.name = "AppError";
    this.status = opts?.status;
    this.hint = opts?.hint;
  }

  // 字符串化时只输出已本地化的说明，避免界面出现 "AppError: " 前缀。
  toString() {
    return this.message;
  }
}

/** 后端错误为 ProviderError 的 JSON 字符串，解析为可读错误 */
function parseBackendError(e: unknown): AppError {
  const raw =
    typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(raw) as {
      status?: number;
      message?: string;
      hint?: string;
      code?: string;
      hint_code?: string;
      params?: Record<string, string | number>;
    };
    if (j && typeof j.message === "string") {
      const params = j.params ?? {};
      return new AppError(localizeMessage(j.code, j.message, params), {
        status: j.status,
        hint:
          j.hint_code != null
            ? localizeMessage(j.hint_code, j.hint ?? "", params)
            : j.hint,
      });
    }
  } catch {
    // 不是 JSON，按纯文本处理
  }
  return new AppError(raw);
}

/** 所有命令经过此入口，后端错误码统一按当前语言展示。 */
async function call<T>(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw parseBackendError(e);
  }
}

// 默认名称由后端留空（不保存本地化文案），在进入界面时按当前语言补全。
function withDefaultName(image: ImportedImage, name: () => string) {
  return image.name ? image : { ...image, name: name() };
}

export async function providerStatus(): Promise<ProviderStatus> {
  if (!isTauri())
    return {
      openrouter: false,
      bfl: false,
      comfy: false,
      runware: false,
      google: false,
      ark: false,
      byteplus: false,
      xai: false,
    };
  return call<ProviderStatus>("provider_status");
}
export const isDesktop = () => isTauri();

export async function generate(
  request: GenerateRequestPayload,
  onProgress?: (progress: GenerationProgress) => void,
): Promise<GenerateOutput> {
  let off: (() => void) | undefined;
  try {
    if (onProgress)
      off = await listen<GenerationProgress>("generation-progress", (event) => {
        if (event.payload.requestId === request.requestId)
          onProgress(event.payload);
      });
    return await call<GenerateOutput>("generate", { request });
  } finally {
    off?.();
  }
}

export interface ImportedImage {
  assetId?: string;
  dataUrl: string;
  width: number;
  height: number;
  name: string;
}

export function importImage(path: string): Promise<ImportedImage> {
  return call<ImportedImage>("import_image", { path });
}

export function saveDataUrl(dataUrl: string, path: string): Promise<string> {
  return call<string>("save_data_url", { dataUrl, path });
}

export function historyList(): Promise<HistoryItem[]> {
  if (!isTauri()) return Promise.resolve([]);
  return call<HistoryItem[]>("history_list");
}

export function historySave(
  item: HistoryItem,
  files: { kind: string; name: string; data: string }[],
): Promise<HistoryItem> {
  return call<HistoryItem>("history_save", { item, files });
}

export function historyDelete(id: string): Promise<void> {
  return call<void>("history_delete", { id });
}

/** 历史图片绝对路径 → asset 协议 URL */
export function assetUrl(absPath: string): string {
  return convertFileSrc(absPath);
}

export const draftLoad = () => call<unknown>("draft_load");
export const draftSave = (draft: Draft | WorkspaceSession) =>
  call<void>("draft_save", { draft });
export const credentialSave = (provider: ProviderId, key: string) =>
  call<void>("credential_save", { provider, key });
export const credentialRemove = (provider: ProviderId) =>
  call<void>("credential_remove", { provider });
export const credentialCheck = async (provider: ProviderId) =>
  localizeStored(await call<string>("credential_check", { provider }));
export const credentialConfigure = (
  provider: ProviderId,
  settings: CredentialSettings,
) => call<void>("credential_configure", { provider, ...settings });
export const importUrl = async (url: string) =>
  withDefaultName(await call<ImportedImage>("import_url", { url }), () =>
    m.default_name_web(),
  );
export const clipboardImage = async () =>
  withDefaultName(await call<ImportedImage>("clipboard_image"), () =>
    m.default_name_clipboard(),
  );
export const copyImage = (dataUrl: string) =>
  call<void>("copy_image", { dataUrl });
export const historyStorage = () =>
  isTauri()
    ? call<string>("history_storage")
    : Promise.resolve(m.error_desktop_only_history());

export const galleryList = async (): Promise<GalleryItem[]> => {
  if (!isTauri()) return [];
  const items = await call<GalleryItem[]>("gallery_list");
  return items.map((item) =>
    item.name ? item : { ...item, name: m.default_name_generated() },
  );
};
export const galleryImport = (
  image: ImportedImage,
  source: "file" | "clipboard" | "url",
) =>
  call<GalleryItem>("gallery_import", {
    dataUrl: image.dataUrl,
    name: image.name,
    source,
  });
export const galleryDelete = (id: string) =>
  call<void>("gallery_delete", { id });
export const galleryRead = async (id: string): Promise<ImportedImage> => ({
  ...withDefaultName(
    await call<ImportedImage>("gallery_read", { id }),
    () => m.default_name_generated(),
  ),
  assetId: id,
});
