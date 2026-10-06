import prices from "../../shared/comfy-pricing.json";
import { defaultsFor } from "./catalog";
import { sentSize } from "../lib/workspace";
import type { Draft } from "../lib/types";
export function estimateComfyCredits(
  d: Draft,
): { min: number; max: number } | null {
  if (d.provider !== "comfy") return null;
  const p = { ...defaultsFor(d.modelId, d.provider), ...d.params };
  const count = Math.max(1, Number(p.count ?? 1));
  if (d.family === "flux") {
    const usd = prices.fluxUsd[p.resolution as keyof typeof prices.fluxUsd];
    return usd == null
      ? null
      : {
          min: usd * prices.creditsPerUsd * count,
          max: usd * prices.creditsPerUsd * count,
        };
  }
  if (d.family === "qwen") {
    const q = prices.qwenCredits;
    if (d.modelId.endsWith("-pro") && (p.width == null || p.height == null))
      return {
        min: q.pro1K * count + d.refs.length * q.reference,
        max: q.pro2K * count + d.refs.length * q.reference,
      };
    const output = d.modelId.endsWith("-pro")
      ? Number(p.width) * Number(p.height) > q.proThresholdPixels
        ? q.pro2K
        : q.pro1K
      : q.standard;
    const total = output * count + d.refs.length * q.reference;
    return { min: total, max: total };
  }
  if (d.family !== "gpt") return null;
  const quality = String(p.quality ?? "auto");
  const ranges = prices.gptUsd.ranges as Record<string, number[]>;
  const presets = prices.gptUsd.presets as Record<
    string,
    Record<string, number>
  >;
  const preset = presets[quality]?.[String(p.size)];
  const range =
    preset == null
      ? (ranges[quality] ?? [ranges.low[0], ranges.max[1]])
      : [preset, preset];
  // Match Comfy's own badge: custom/auto sizes use a range. Input reference
  // prices use the official range; prompt tokens are only a rough estimate.
  const refs = d.refs.reduce((n, image) => {
    const size = sentSize(image, d.compressEnabled, d.maxInputEdge);
    return n + Math.max(1, (size.w * size.h) / (1024 * 1024));
  }, 0);
  const textCredits = (Math.ceil(d.prompt.length / 4) * 1508.65) / 1e6;
  return {
    min:
      (range[0] * prices.creditsPerUsd +
        refs * prices.gptUsd.reference[0] * prices.creditsPerUsd +
        textCredits) *
      count,
    max:
      (range[1] * prices.creditsPerUsd +
        refs * prices.gptUsd.reference[1] * prices.creditsPerUsd +
        textCredits) *
      count,
  };
}
export function formatCredits(n: number) {
  return n.toFixed(2);
}
