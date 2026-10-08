import type { Draft } from "../lib/types";
import { formatNumber, m } from "../i18n";
import { fieldsFor, routeFor } from "./catalog";

export function validateQwen(d: Draft): string[] {
  const errors: string[] = [];
  if (
    fieldsFor(d).width &&
    (d.params.width === null) !== (d.params.height === null)
  )
    errors.push(m.error_dimensions_together());
  if (
    fieldsFor(d).width &&
    !fieldsFor(d).width.nullable &&
    d.params.width === null &&
    d.params.height === null
  )
    errors.push(m.error_dimensions_required());
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
        m.error_qwen_area({
          max: formatNumber(routeFor(d)?.maxPixels ?? 4194304),
        }),
      );
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
