import type { Box, Draft, Preferences, Rect, WorkingImage } from "./types";
import { DEFAULT_PARAMS, phantomSize, validateParams } from "./params";
import { BOX_COLORS, drawBoxColor } from "./boxColors";

export const DEFAULT_PREFERENCES: Preferences = { sidebarWidthPercent: 25, saveDirectory: "", theme: "system", provider: "openrouter", params: DEFAULT_PARAMS, compressEnabled: true, maxInputEdge: 2048 };
export function newDraft(p = DEFAULT_PREFERENCES): Draft {
  return { schema: 2, refs: [], boxes: [], prompt: "", params: { ...p.params }, provider: p.provider, baseId: null, canvas: phantomSize(p.params.aspectRatio), compressEnabled: p.compressEnabled, maxInputEdge: p.maxInputEdge };
}
export function withIds(d: Draft): Draft {
  let pool = [...(d.colorPool ?? [])].filter(c => (BOX_COLORS as readonly string[]).includes(c));
  const boxes = d.boxes.map(b => {
    let color = b.color;
    if (!color) { const drawn = drawBoxColor(pool); color = drawn.color; pool = drawn.remaining; }
    return { ...b, uid: b.uid ?? crypto.randomUUID(), color };
  });
  return { ...d, colorPool: pool, refs: d.refs.map(r => ({ ...r, uid: r.uid ?? crypto.randomUUID() })), boxes };
}
export function scaleRect(r: Rect, from: { w: number; h: number }, to: { w: number; h: number }): Rect {
  return { x: r.x / from.w * to.w, y: r.y / from.h * to.h, w: r.w / from.w * to.w, h: r.h / from.h * to.h };
}
export function resizeCanvas(d: Draft, canvas: Draft["canvas"]): Draft {
  return { ...d, canvas, boxes: d.boxes.map(b => ({ ...b, rect: scaleRect(b.rect, d.canvas, canvas) })) };
}
export function renameBox(d: Draft, uid: string, id: string): Draft {
  const old = d.boxes.find(b => b.uid === uid);
  if (!old) return d;
  return { ...d, prompt: d.prompt.split("<" + old.id + ">").join("<" + id + ">"), boxes: d.boxes.map(b => b.uid === uid ? { ...b, id } : b) };
}
export function reorderRefs(d: Draft, refs: WorkingImage[]): Draft {
  const replacements = new Map(d.refs.map((r, i) => ["ref_image_" + i, refs.findIndex(n => n.uid === r.uid)]));
  return { ...d, refs, prompt: d.prompt.replace(/<ref_image_(\d+)>/g, (tag, n: string) => {
    const index = replacements.get("ref_image_" + n);
    return index !== undefined && index >= 0 ? "<ref_image_" + index + ">" : tag;
  }) };
}
export function sentSize(r: WorkingImage, enabled: boolean, edge: number) {
  const k = enabled ? Math.min(1, edge / Math.max(r.width, r.height)) : 1;
  return { w: Math.max(1, Math.round(r.width * k)), h: Math.max(1, Math.round(r.height * k)) };
}
export function validateDraft(d: Draft): string[] {
  const errors = validateParams(d.params, d.refs.length ? "edit" : "t2i", d.provider);
  if (d.compressEnabled && (!Number.isInteger(d.maxInputEdge) || d.maxInputEdge < 256 || d.maxInputEdge > 8192)) errors.push("压缩长边上限须为 256–8192 的整数");
  if (d.refs.length > 10) errors.push("参考图最多 10 张");
  if (d.provider === "bfl") for (const r of d.refs) {
    const s = sentSize(r, d.compressEnabled, d.maxInputEdge);
    if (s.w < 256 || s.h < 256 || s.w * s.h > 16_000_000) errors.push(r.name + " 发送尺寸 " + s.w + "×" + s.h + " 不符合 BFL：每边至少 256px、面积至多 16MP。请提高压缩上限或替换图片。");
  }
  return errors;
}
export function changeRole(b: Box, role: Box["role"], d: Draft): Box {
  const source = d.refs.find(r => r.uid === b.sourceId) ?? d.refs.find(r => r.uid === d.baseId) ?? d.refs[0];
  return { ...b, role, sourceId: source?.uid, srcRect: ["move", "anchor", "remove"].includes(role) && source ? b.srcRect ?? scaleRect(b.rect, d.canvas, { w: source.width, h: source.height }) : undefined };
}
export function outputEstimate(d: Draft) {
  const edge = ({ "768": 768, "1K": 1024, "1.5K": 1536, "2K": 2048, "4K": 4096 } as Record<string, number>)[d.params.resolution] ?? 1024;
  const ratio = d.canvas.w / d.canvas.h;
  return { w: Math.round(edge * Math.sqrt(ratio) / 16) * 16, h: Math.round(edge / Math.sqrt(ratio) / 16) * 16 };
}
