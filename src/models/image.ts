import type { Draft } from "../lib/types";
import { defaultsFor, fieldsFor, routeFor } from "./catalog";
import { sentSize } from "../lib/workspace";

export function validateImage(d: Draft): string[] {
  const fields = fieldsFor(d),
    route = routeFor(d);
  if (!route) return [];
  const p = { ...defaultsFor(d.modelId, d.provider), ...d.params };
  const errors: string[] = [];
  for (const ref of d.refs) {
    const size = sentSize(ref, d.compressEnabled, d.maxInputEdge);
    if (
      d.family === "seedream" &&
      d.provider !== "openrouter" &&
      (Math.min(size.w, size.h) < 15 ||
        Math.max(size.w, size.h) / Math.min(size.w, size.h) > 16 ||
        (route.maxInputPixels != null &&
          size.w * size.h > route.maxInputPixels))
    )
      errors.push("参考图尺寸或宽高比超过此路由限制，请缩小或裁剪图片");
  }
  if (fields.width) {
    const w = p.width,
      h = p.height;
    if ((w == null) !== (h == null)) errors.push("宽度和高度须同时设置");
    if ((w == null || h == null) && !fields.width.nullable)
      errors.push("当前供应商需要指定宽度和高度");
    if (
      w != null &&
      h != null &&
      (w * h < (route.minPixels ?? 1) ||
        w * h > (route.maxPixels ?? Infinity) ||
        Math.max(w, h) / Math.min(w, h) > (route.maxAspect ?? Infinity))
    )
      errors.push(
        `输出面积须为 ${route.minPixels?.toLocaleString()}–${route.maxPixels?.toLocaleString()}px，比例至多 ${route.maxAspect}:1`,
      );
  }
  if (
    ["gemini", "grok"].includes(d.family) &&
    d.provider === "runware" &&
    p.aspectRatio === "auto" &&
    !d.refs.length
  )
    errors.push("自动比例需要参考图，请选择输出比例");
  return errors;
}
