import { m } from "../../i18n";
import type { Rect, WorkingImage } from "../../lib/types";
/** Native GPT mask: alpha zero is editable; opaque pixels are preserved. */
export function maskFromRects(
  image: WorkingImage,
  rects: Rect[],
): WorkingImage {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(m.error_mask_canvas());
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, image.width, image.height);
  for (const r of rects)
    ctx.clearRect(
      Math.floor(r.x),
      Math.floor(r.y),
      Math.ceil(r.w),
      Math.ceil(r.h),
    );
  return {
    uid: crypto.randomUUID(),
    dataUrl: canvas.toDataURL("image/png"),
    width: image.width,
    height: image.height,
    name: m.name_mask(),
  };
}
