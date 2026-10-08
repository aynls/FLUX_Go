// OpenRouter FLUX 的分辨率费用提示，以及没有参考图时的画布占位尺寸。
// 参数是否合法由模型目录决定。

import type { GenerateParams } from "./types";

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

export const DEFAULT_PARAMS: GenerateParams = {
  resolution: "1K",
  aspectRatio: "1:1",
  safetyTolerance: null,
  grounding: true,
  version: "latest",
};

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
