import type { Draft } from "../lib/types";
import { fieldsFor, routeFor } from "./catalog";

export function validateQwen(d: Draft): string[] {
  const errors: string[] = [];
  if (
    fieldsFor(d).width &&
    (d.params.width === null) !== (d.params.height === null)
  )
    errors.push("宽度和高度须同时设置");
  if (
    fieldsFor(d).width &&
    !fieldsFor(d).width.nullable &&
    d.params.width === null &&
    d.params.height === null
  )
    errors.push("当前供应商需要指定宽度和高度");
  if (
    fieldsFor(d).width &&
    !(
      d.params.width === null &&
      d.params.height === null &&
      fieldsFor(d).width.nullable
    )
  ) {
    const w = d.params.width ?? 1024,
      h = d.params.height ?? 1024;
    if (
      w * h < 262144 ||
      w * h > (routeFor(d)?.maxPixels ?? 4194304) ||
      Math.max(w, h) / Math.min(w, h) > 8
    )
      errors.push(
        `Qwen 尺寸面积须为 262,144–${(routeFor(d)?.maxPixels ?? 4194304).toLocaleString()}px，宽高比例至多 8:1`,
      );
  }
  if (
    fieldsFor(d).promptExtendMode &&
    d.params.promptExtend &&
    d.refs.length &&
    d.params.promptExtendMode === "agent"
  )
    errors.push("Qwen 参考图编辑仅支持 direct 扩写");
  return errors;
}
