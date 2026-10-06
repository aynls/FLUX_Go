// Tauri 后端命令的类型化封装与错误解析。

import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
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
    };
    if (j && typeof j.message === "string") {
      return new AppError(j.message, { status: j.status, hint: j.hint });
    }
  } catch {
    // 不是 JSON，按纯文本处理
  }
  return new AppError(raw);
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
    };
  return invoke<ProviderStatus>("provider_status");
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
    return await invoke<GenerateOutput>("generate", { request });
  } catch (e) {
    throw parseBackendError(e);
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
  return invoke<ImportedImage>("import_image", { path });
}

export function saveDataUrl(dataUrl: string, path: string): Promise<string> {
  return invoke<string>("save_data_url", { dataUrl, path });
}

export function historyList(): Promise<HistoryItem[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke<HistoryItem[]>("history_list");
}

export function historySave(
  item: HistoryItem,
  files: { kind: string; name: string; data: string }[],
): Promise<HistoryItem> {
  return invoke<HistoryItem>("history_save", { item, files });
}

export function historyDelete(id: string): Promise<void> {
  return invoke<void>("history_delete", { id });
}

/** 历史图片绝对路径 → asset 协议 URL */
export function assetUrl(absPath: string): string {
  return convertFileSrc(absPath);
}

export const draftLoad = () => invoke<unknown>("draft_load");
export const draftSave = (draft: Draft | WorkspaceSession) =>
  invoke<void>("draft_save", { draft });
export const credentialSave = (provider: ProviderId, key: string) =>
  invoke<void>("credential_save", { provider, key });
export const credentialRemove = (provider: ProviderId) =>
  invoke<void>("credential_remove", { provider });
export const credentialCheck = (provider: ProviderId) =>
  invoke<string>("credential_check", { provider });
export const credentialConfigure = (
  provider: ProviderId,
  settings: CredentialSettings,
) => invoke<void>("credential_configure", { provider, ...settings });
export const importUrl = (url: string) =>
  invoke<ImportedImage>("import_url", { url });
export const clipboardImage = () => invoke<ImportedImage>("clipboard_image");
export const copyImage = (dataUrl: string) =>
  invoke<void>("copy_image", { dataUrl });
export const historyStorage = () =>
  isTauri()
    ? invoke<string>("history_storage")
    : Promise.resolve("请在桌面应用中查看历史目录");

export const galleryList = () =>
  isTauri() ? invoke<GalleryItem[]>("gallery_list") : Promise.resolve([]);
export const galleryImport = (
  image: ImportedImage,
  source: "file" | "clipboard" | "url",
) =>
  invoke<GalleryItem>("gallery_import", {
    dataUrl: image.dataUrl,
    name: image.name,
    source,
  });
export const galleryDelete = (id: string) =>
  invoke<void>("gallery_delete", { id });
export const galleryRead = async (id: string): Promise<ImportedImage> => ({
  ...(await invoke<ImportedImage>("gallery_read", { id })),
  assetId: id,
});
