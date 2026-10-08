// FLUX.3 Image 官方布局协议（来源：docs.bfl.ai/flux_3/flux3_image_bounding_boxes、
// flux3_image_layout 页面中的请求体构造函数）：
//
//   编辑模式：prompt = instruction + " " + JSON.stringify([{id, from, src_bbox, tgt_bbox, desc}])
//   文生图放置：prompt = instruction + " " + JSON.stringify([{id, bbox, desc}])
//
// 坐标为 0–1000 归一化，顺序为 [y0, x0, y1, x1]（文档渲染函数 pct([y0,x0,y1,x1]) 证实）。
// 注意：OpenRouter 未提供结构化包围盒字段，该协议经由 prompt 字段原样传输——
// 这是 BFL 官方定义的请求体格式，两个提供商（OpenRouter / BFL 直连）完全一致。

import type { Box, Rect, WorkingImage } from "../../lib/types";
import { m } from "../../i18n";

export const MODEL_FLUX3 = "black-forest-labs/flux-3-image";
export const MODEL_NAME = "FLUX.3 Image";

export type WireBbox = [number, number, number, number];

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 画布像素矩形 → 协议坐标 [y0, x0, y1, x1]（0–1000，最小 1 单位） */
export function rectToWire(r: Rect, iw: number, ih: number): WireBbox {
  const sx = (v: number) => Math.round(clamp01(v / iw) * 1000);
  const sy = (v: number) => Math.round(clamp01(v / ih) * 1000);
  const y0 = Math.min(999, sy(r.y));
  const x0 = Math.min(999, sx(r.x));
  const y1 = Math.min(1000, Math.max(y0 + 1, sy(r.y + r.h)));
  const x1 = Math.min(1000, Math.max(x0 + 1, sx(r.x + r.w)));
  return [y0, x0, y1, x1];
}

/** 协议坐标 → 画布像素矩形（历史回填用） */
export function wireToRect(wire: unknown, iw: number, ih: number): Rect {
  if (!Array.isArray(wire) || wire.length < 4)
    return { x: 0, y: 0, w: iw / 4, h: ih / 4 };
  const [y0, x0, y1, x1] = wire as number[];
  return {
    x: ((x0 ?? 0) / 1000) * iw,
    y: ((y0 ?? 0) / 1000) * ih,
    w: Math.max(1, (((x1 ?? 0) - (x0 ?? 0)) / 1000) * iw),
    h: Math.max(1, (((y1 ?? 0) - (y0 ?? 0)) / 1000) * ih),
  };
}

export interface EditRow {
  id: string;
  from: string | null;
  src_bbox: WireBbox | null;
  tgt_bbox: WireBbox | null;
  desc: string;
}

export interface PlaceRow {
  id: string;
  bbox: WireBbox;
  desc: string;
}

/** 单个框 → 编辑模式协议行 */
export function boxToEditRow(
  b: Box,
  iw: number,
  ih: number,
  hasInput: boolean,
  refs?: WorkingImage[],
): EditRow {
  const tgt_bbox = rectToWire(b.rect, iw, ih);
  if (["new", "modify", "place"].includes(b.role)) {
    return { id: b.id, from: null, src_bbox: null, tgt_bbox, desc: b.desc };
  }
  const index = refs ? refs.findIndex((r) => r.uid === b.sourceId) : 0;
  const source = refs?.[index];
  const sw = source?.width ?? iw;
  const sh = source?.height ?? ih;
  const srcRect = b.srcRect ?? {
    x: (b.rect.x * sw) / iw,
    y: (b.rect.y * sh) / ih,
    w: (b.rect.w * sw) / iw,
    h: (b.rect.h * sh) / ih,
  };
  return {
    id: b.id,
    from: hasInput ? `ref_image_${index}` : null,
    src_bbox: rectToWire(srcRect, sw, sh),
    tgt_bbox:
      b.role === "remove"
        ? null
        : b.role === "anchor"
          ? rectToWire(srcRect, sw, sh)
          : tgt_bbox,
    desc: b.desc,
  };
}

export interface ComposeResult {
  finalPrompt: string;
  rows: EditRow[] | PlaceRow[];
  error: string | null;
}

/**
 * 合成最终提示词。mode：
 *  - edit：有参考图。框角色 new/anchor/move，见 boxToEditRow。
 *  - t2i：无参考图。所有框为放置框 {id, bbox, desc}。
 */
export function composePrompt(opts: {
  mode: "edit" | "t2i";
  instruction: string;
  boxes: Box[];
  iw: number;
  ih: number;
  refs?: WorkingImage[];
}): ComposeResult {
  const instruction = opts.instruction.trim();
  const fail = (error: string): ComposeResult => ({
    finalPrompt: "",
    rows: [],
    error,
  });

  if (!instruction) return fail(m.error_prompt_required());
  if (!opts.iw || !opts.ih) return fail(m.error_canvas_size());

  const ids = new Set<string>();
  for (const b of opts.boxes) {
    if (!/^[A-Za-z0-9_]+$/.test(b.id)) {
      return fail(m.error_box_id({ id: b.id }));
    }
    if (ids.has(b.id)) return fail(m.error_box_duplicate({ id: b.id }));
    ids.add(b.id);
    if (!b.desc.trim()) return fail(m.error_box_desc({ id: b.id }));
    if (["move", "remove"].includes(b.role) && !b.srcRect) {
      return fail(m.error_box_source({ id: b.id }));
    }
    if (opts.mode === "t2i" && ["move", "anchor", "remove"].includes(b.role))
      return fail(m.error_box_ref({ id: b.id }));
    if (
      opts.refs &&
      ["move", "anchor", "remove"].includes(b.role) &&
      !opts.refs.some((r) => r.uid === b.sourceId)
    )
      return fail(m.error_box_ref_missing({ id: b.id }));
  }

  if (opts.boxes.length === 0) {
    return { finalPrompt: instruction, rows: [], error: null };
  }

  let rows: EditRow[] | PlaceRow[];
  if (opts.mode === "edit") {
    rows = opts.boxes.map((b) =>
      boxToEditRow(b, opts.iw, opts.ih, true, opts.refs),
    );
  } else {
    rows = opts.boxes.map((b) => ({
      id: b.id,
      bbox: rectToWire(b.rect, opts.iw, opts.ih),
      desc: b.desc,
    }));
  }

  return {
    finalPrompt: `${instruction} ${JSON.stringify(rows)}`,
    rows,
    error: null,
  };
}
