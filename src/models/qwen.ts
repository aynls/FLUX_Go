import type { Draft } from "../lib/types";
import { formatNumber, m } from "../i18n";
import { fieldsFor, routeFor } from "./catalog";

export function validateQwen(d: Draft): string[] {
  const errors: string[] = [];
  const fields = fieldsFor(d);
  const route = routeFor(d);
  if (fields.width && (d.params.width === null) !== (d.params.height === null))
    errors.push(m.error_dimensions_together());
  if (
    fields.width &&
    !fields.width.nullable &&
    d.params.width === null &&
    d.params.height === null
  )
    errors.push(m.error_dimensions_required());
  if (
    fields.width &&
    !(
      d.params.width === null &&
      d.params.height === null &&
      fields.width.nullable
    )
  ) {
    const w = d.params.width ?? 1024,
      h = d.params.height ?? 1024;
    const max = route?.maxPixels ?? 4194304;
    if (
      w * h < (route?.minPixels ?? 262144) ||
      w * h > max ||
      Math.max(w, h) / Math.min(w, h) > (route?.maxAspect ?? 8)
    )
      errors.push(m.error_qwen_area({ max: formatNumber(max) }));
  }
  if (
    fieldsFor(d).promptExtendMode &&
    d.params.promptExtend &&
    d.refs.length &&
    d.params.promptExtendMode === "agent"
  )
    errors.push(m.error_qwen_direct());
  return errors;
}
