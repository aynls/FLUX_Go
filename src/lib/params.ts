// 参数定义与校验。只开放 flux-3-image 端点在 OpenRouter 上实际支持的参数；
// 定价来自 OpenRouter /api/v1/images/models/.../endpoints 记录（2026-10-05）。

import type { GenerateParams, ProviderId } from "./types";

export interface ResolutionOption {
  value: string;
  label: string;
  costUsd: number;
}

export const RESOLUTIONS: ResolutionOption[] = [
  { value: "768", label: "768", costUsd: 0.041 },
  { value: "1K", label: "1K", costUsd: 0.048 },
  { value: "1.5K", label: "1.5K", costUsd: 0.07 },
  { value: "2K", label: "2K", costUsd: 0.1 },
  { value: "4K", label: "4K", costUsd: 0.607 },
];

export const ASPECT_RATIOS: string[] = [
  "21:9",
  "2:1",
  "16:9",
  "3:2",
  "7:5",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "5:7",
  "2:3",
  "9:16",
  "1:2",
  "9:21",
  "auto",
];

export const DEFAULT_PARAMS: GenerateParams = {
  resolution: "1K",
  aspectRatio: "1:1",
  safetyTolerance: null,
  grounding: true,
  version: "latest",
};

export const MAX_INPUT_EDGE_DEFAULT = 2048;

export function estimateCost(resolution: string | undefined): number | null {
  return RESOLUTIONS.find((r) => r.value === resolution)?.costUsd ?? null;
}

/** 文生图模式下画布使用的幻影尺寸（比例与输出一致） */
export function phantomSize(aspectRatio: string): { w: number; h: number } {
  let a = 1;
  let b = 1;
  if (aspectRatio !== "auto" && aspectRatio.includes(":")) {
    const [x, y] = aspectRatio.split(":").map(Number);
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) {
      a = x;
      b = y;
    }
  }
  const w = 1024;
  return { w, h: Math.round((w * b) / a) };
}

export function validateParams(
  p: GenerateParams,
  _mode: "edit" | "t2i",
  _provider: ProviderId = "openrouter",
): string[] {
  const errors: string[] = [];
  if (!RESOLUTIONS.some((r) => r.value === p.resolution)) {
    errors.push(`分辨率 ${p.resolution} 无效（允许 768/1K/1.5K/2K/4K）`);
  }
  if (!ASPECT_RATIOS.includes(p.aspectRatio ?? "")) {
    errors.push(`宽高比 ${p.aspectRatio} 无效`);
  }
  if (p.version && p.version !== "latest") errors.push("模型版本仅支持 latest");
  if (p.safetyTolerance != null) {
    const v = p.safetyTolerance;
    const max = 4;
    if (!Number.isInteger(v) || v < 0 || v > max) {
      errors.push(`safety_tolerance 必须是 0–${max} 的整数，或留空`);
    }
  }
  return errors;
}
