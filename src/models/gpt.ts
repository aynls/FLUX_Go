import type { Draft } from "../lib/types";
import { m } from "../i18n";
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
      errors.push(m.error_gpt_size());
  }
  if (d.params.background === "transparent" && d.params.outputFormat === "jpeg")
    errors.push(m.error_transparent_format());
  if (d.mask) {
    const first = d.refs[0];
    if (!first) errors.push(m.error_mask_needs_ref());
    else if (first.width !== d.mask.width || first.height !== d.mask.height)
      errors.push(m.error_mask_size());
    if (!d.mask.dataUrl.startsWith("data:image/png;base64,"))
      errors.push(m.error_mask_png());
  }
  return errors;
}
