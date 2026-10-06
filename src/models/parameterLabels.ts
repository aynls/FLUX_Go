import type { GenerateParams } from "../lib/types";

const VALUE_LABELS: Record<string, string> = {
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
  opaque: "不透明",
  transparent: "透明",
  direct: "直接扩写",
  agent: "推理扩写",
  latest: "最新版本",
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP",
};
export function displayValue(key: string, value: GenerateParams[string]) {
  if (value == null) return key === "seed" ? "随机" : "供应商默认";
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  return VALUE_LABELS[String(value)] ?? String(value);
}
