// 画布坐标与视图变换的纯函数。所有矩形使用画布/原图像素坐标，
// 屏幕坐标 = 图像坐标 × scale + (tx, ty)。

export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 缩放倍率：1 = 100%。所有画布缩放入口统一使用这两个边界。
export const MIN_SCALE = 0.6;
export const MAX_SCALE = 1.5;
// 边缘可达范围之外的额外平移倍率：1 = 无额外留白，1.5 = 每侧增加画布尺寸的 25%。
export const PAN_RANGE_MULTIPLIER = 1.2;
// 到达平移边界时，仍保留的可见画布边缘（屏幕 px）。
export const MIN_VISIBLE_CANVAS_PX = 64;

export function clampScale(s: number, minScale = MIN_SCALE): number {
  return Math.min(MAX_SCALE, Math.max(minScale, s));
}

/** 高分辨率预览允许缩小到完整显示；FLUX 编辑画布仍使用原有缩放下限。 */
export function fitMinimumScale(
  iw: number,
  ih: number,
  vw: number,
  vh: number,
  pad = 24,
): number {
  if (iw <= 0 || ih <= 0 || vw <= 0 || vh <= 0) return MIN_SCALE;
  return Math.min(
    MIN_SCALE,
    Math.max(0.01, Math.min((vw - pad * 2) / iw, (vh - pad * 2) / ih)),
  );
}

/** 在视口内完整显示图像（含边距），居中 */
export function fitView(
  iw: number,
  ih: number,
  vw: number,
  vh: number,
  pad = 24,
  minScale = MIN_SCALE,
): View {
  if (iw <= 0 || ih <= 0 || vw <= 0 || vh <= 0)
    return { scale: 1, tx: 0, ty: 0 };
  const scale = clampScale(
    Math.min((vw - pad * 2) / iw, (vh - pad * 2) / ih),
    minScale,
  );
  return { scale, tx: (vw - iw * scale) / 2, ty: (vh - ih * scale) / 2 };
}

export function screenToImg(
  v: View,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
}

export function imgToScreen(
  v: View,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: x * v.scale + v.tx, y: y * v.scale + v.ty };
}

/** 以屏幕点 (sx, sy) 为锚缩放：该点下的图像内容保持不动 */
export function zoomAt(
  v: View,
  sx: number,
  sy: number,
  factor: number,
  minScale = MIN_SCALE,
): View {
  const scale = clampScale(v.scale * factor, minScale);
  const k = scale / v.scale;
  return { scale, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k };
}

/** 平移范围覆盖画布超出视口的部分，并允许额外留白，同时保留可见画布边缘。 */
export function clampCanvasView(
  v: View,
  iw: number,
  ih: number,
  vw: number,
  vh: number,
  minScale = MIN_SCALE,
): View {
  const scale = clampScale(v.scale, minScale);
  if (iw <= 0 || ih <= 0 || vw <= 0 || vh <= 0) return { ...v, scale };
  const axis = (offset: number, image: number, viewport: number) => {
    const span = image * scale;
    const center = (viewport - span) / 2;
    const visible = Math.min(MIN_VISIBLE_CANVAS_PX, viewport / 4, span);
    const travel =
      Math.max(0, span - viewport) / 2 +
      (span * Math.max(0, PAN_RANGE_MULTIPLIER - 1)) / 2;
    return clamp(
      offset,
      Math.max(center - travel, visible - span),
      Math.min(center + travel, viewport - visible),
    );
  };
  return { scale, tx: axis(v.tx, iw, vw), ty: axis(v.ty, ih, vh) };
}

export function zoomCanvasAt(
  v: View,
  sx: number,
  sy: number,
  factor: number,
  iw: number,
  ih: number,
  vw: number,
  vh: number,
  minScale = MIN_SCALE,
): View {
  return clampCanvasView(
    zoomAt(v, sx, sy, factor, minScale),
    iw,
    ih,
    vw,
    vh,
    minScale,
  );
}

export function normalizeRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

/** 与图像求交集（框超出边界时只保留图内部分） */
export function clampRectToImage(r: Rect, iw: number, ih: number): Rect {
  const x0 = clamp(r.x, 0, Math.max(0, iw));
  const y0 = clamp(r.y, 0, Math.max(0, ih));
  const x1 = clamp(r.x + r.w, 0, Math.max(0, iw));
  const y1 = clamp(r.y + r.h, 0, Math.max(0, ih));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** 拖拽创建：归一化 + 裁剪 */
export function rectFromDrag(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  iw: number,
  ih: number,
): Rect {
  return clampRectToImage(normalizeRect(x0, y0, x1, y1), iw, ih);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function handlePoint(r: Rect, h: Handle): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return {
    x: h.includes("w") ? r.x : h.includes("e") ? r.x + r.w : cx,
    y: h.includes("n") ? r.y : h.includes("s") ? r.y + r.h : cy,
  };
}

/**
 * 以对侧为锚调整尺寸，强制最小尺寸，并裁剪回图像内。
 * 边缘处允许小于 minSize（图像本身不够大时）。
 */
export function resizeRect(
  r: Rect,
  h: Handle,
  dx: number,
  dy: number,
  minSize: number,
  iw: number,
  ih: number,
): Rect {
  const min = Math.max(1, Math.min(minSize, iw, ih));
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.w;
  let y1 = r.y + r.h;
  if (h.includes("w")) x0 += dx;
  if (h.includes("e")) x1 += dx;
  if (h.includes("n")) y0 += dy;
  if (h.includes("s")) y1 += dy;
  if (x1 - x0 < min) {
    if (h.includes("w")) x0 = x1 - min;
    else x1 = x0 + min;
  }
  if (y1 - y0 < min) {
    if (h.includes("n")) y0 = y1 - min;
    else y1 = y0 + min;
  }
  x0 = clamp(x0, 0, Math.max(0, iw));
  x1 = clamp(x1, 0, Math.max(0, iw));
  y0 = clamp(y0, 0, Math.max(0, ih));
  y1 = clamp(y1, 0, Math.max(0, ih));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export function hitTest(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 命中检测手柄，容差为屏幕像素（转换为图像像素） */
export function pickHandle(
  r: Rect,
  imgX: number,
  imgY: number,
  scale: number,
  tolScreenPx = 7,
): Handle | null {
  const tol = tolScreenPx / Math.max(scale, 1e-6);
  for (const h of HANDLES) {
    const p = handlePoint(r, h);
    if (Math.abs(imgX - p.x) <= tol && Math.abs(imgY - p.y) <= tol) return h;
  }
  return null;
}

/** 拖动整个框：位置钳制在图像内，返回新 rect */
export function moveRect(
  orig: Rect,
  dx: number,
  dy: number,
  iw: number,
  ih: number,
): Rect {
  const x = clamp(orig.x + dx, 0, Math.max(0, iw - orig.w));
  const y = clamp(orig.y + dy, 0, Math.max(0, ih - orig.h));
  return { ...orig, x, y };
}
