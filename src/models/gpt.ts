import type { Draft } from "../lib/types";
import { fieldsFor } from "./catalog";

export function gptSize(size: string | undefined) {
  const match = /^(\d+)\s*[xX×*]\s*(\d+)$/.exec((size ?? "").trim());
  return match ? { w: Number(match[1]), h: Number(match[2]) } : null;
}
export function validateGpt(d: Draft): string[] {
  const errors: string[] = [];
  const fields = fieldsFor(d);
  if (fields.size) {
    const size = gptSize(d.params.size);
    if (d.params.size === "auto" && fields.size.allowAuto) {
      /* Provider chooses. */
    } else if (
      !size ||
      size.w % 16 ||
      size.h % 16 ||
      Math.max(size.w, size.h) > 3840 ||
      size.w * size.h < 655360 ||
      size.w * size.h > 8294400 ||
      Math.max(size.w, size.h) / Math.min(size.w, size.h) > 3
    )
      errors.push(
        "GPT Image 尺寸须为宽x高、16 的倍数、每边至多 3840px、面积 655,360–8,294,400px、比例至多 3:1",
      );
  }
  if (d.params.background === "transparent" && d.params.outputFormat === "jpeg")
    errors.push("透明背景需选择 PNG 或 WebP");
  if (d.mask) {
    const first = d.refs[0];
    if (!first) errors.push("蒙版需要至少一张参考图，作用于第一张图片");
    else if (first.width !== d.mask.width || first.height !== d.mask.height)
      errors.push("蒙版尺寸须与第一张参考图一致");
    if (!d.mask.dataUrl.startsWith("data:image/png;base64,"))
      errors.push("蒙版须为 PNG 图片");
  }
  return errors;
}
