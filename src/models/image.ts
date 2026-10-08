import type { Draft } from "../lib/types";
import { formatNumber, m } from "../i18n";
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
      errors.push(m.error_ref_dimensions());
  }
  if (fields.width) {
    const w = p.width,
      h = p.height;
    if ((w == null) !== (h == null)) errors.push(m.error_dimensions_together());
    if ((w == null || h == null) && !fields.width.nullable)
      errors.push(m.error_dimensions_required());
    if (
      w != null &&
      h != null &&
      (w * h < (route.minPixels ?? 1) ||
        w * h > (route.maxPixels ?? Infinity) ||
        Math.max(w, h) / Math.min(w, h) > (route.maxAspect ?? Infinity))
    )
      errors.push(
        m.error_output_area({
          min:
            typeof route.minPixels === "number"
              ? formatNumber(route.minPixels)
              : String(route.minPixels),
          max:
            typeof route.maxPixels === "number"
              ? formatNumber(route.maxPixels)
              : String(route.maxPixels),
          aspect: String(route.maxAspect),
        }),
      );
  }
  if (
    ["gemini", "grok"].includes(d.family) &&
    d.provider === "runware" &&
    p.aspectRatio === "auto" &&
    !d.refs.length
  )
    errors.push(m.error_auto_aspect_needs_ref());
  return errors;
}
