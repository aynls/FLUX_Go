import type {
  Box,
  Draft,
  FamilyId,
  Preferences,
  Rect,
  WorkingImage,
  WorkspaceSession,
} from "./types";
import { DEFAULT_PARAMS, phantomSize } from "./params";
import { BOX_COLORS, drawBoxColor } from "./boxColors";
import {
  defaultsFor,
  familyById,
  fieldsFor,
  modelById,
  providers,
} from "../models/catalog";
import { validateModel } from "../models";
import { gptSize } from "../models/gpt";

export const DEFAULT_PREFERENCES: Preferences = {
  defaultFamily: "flux",
  sidebarWidthPercent: 25,
  saveDirectory: "",
  theme: "system",
  provider: "openrouter",
  params: DEFAULT_PARAMS,
  compressEnabled: true,
  maxInputEdge: 2048,
};
export function newDraft(
  p = DEFAULT_PREFERENCES,
  family: FamilyId = p.defaultFamily ?? "flux",
): Draft {
  const modelId = familyById(family).defaultModel;
  const provider = modelById(modelId)?.routes[p.provider]
    ? p.provider
    : "openrouter";
  const params = {
    ...defaultsFor(modelId, provider),
    ...(family === "flux" ? p.params : {}),
  };
  return {
    schema: 3,
    family,
    modelId,
    mask: null,
    refs: [],
    boxes: [],
    prompt: "",
    params,
    provider,
    baseId: null,
    canvas: phantomSize(params.aspectRatio ?? "1:1"),
    compressEnabled: p.compressEnabled,
    maxInputEdge: p.maxInputEdge,
  };
}

export function migrateDraft(value: unknown): Draft {
  if (!value || typeof value !== "object") throw new Error("草稿内容无效");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== 2 && raw.schema !== 3) throw new Error("草稿版本不兼容");
  const family = raw.schema === 2 ? "flux" : raw.family;
  const modelId = raw.schema === 2 ? "flux-3-image" : raw.modelId;
  const model = typeof modelId === "string" ? modelById(modelId) : undefined;
  if (
    !model ||
    model.family !== family ||
    !providers.some((p) => p.id === raw.provider)
  )
    throw new Error("草稿的模型或供应商无效");
  const canvas = raw.canvas as Draft["canvas"] | undefined;
  if (
    !Array.isArray(raw.refs) ||
    !Array.isArray(raw.boxes) ||
    !canvas ||
    !Number.isFinite(canvas.w) ||
    !Number.isFinite(canvas.h) ||
    canvas.w <= 0 ||
    canvas.h <= 0 ||
    typeof raw.prompt !== "string" ||
    !raw.params ||
    typeof raw.params !== "object"
  )
    throw new Error("草稿缺少必要内容");
  for (const ref of raw.refs as WorkingImage[])
    if (
      !ref ||
      typeof ref.dataUrl !== "string" ||
      typeof ref.name !== "string" ||
      !(ref.width > 0 && ref.height > 0)
    )
      throw new Error("草稿参考图无效");
  return withIds({
    ...newDraft(DEFAULT_PREFERENCES, model.family),
    ...raw,
    schema: 3,
    family: model.family,
    modelId: model.id,
    params: {
      ...defaultsFor(model.id, raw.provider as Draft["provider"]),
      ...raw.params,
    },
    mask: (raw.mask ?? null) as WorkingImage | null,
  } as Draft);
}
export function migrateSession(value: unknown): WorkspaceSession | null {
  if (value == null) return null;
  const raw = value as Partial<WorkspaceSession>;
  if (raw.schema !== 1) {
    const draft = migrateDraft(value);
    return {
      schema: 1,
      activeFamily: draft.family,
      workspaces: { [draft.family]: draft },
    };
  }
  if (!raw.workspaces || !raw.activeFamily || !familyById(raw.activeFamily))
    throw new Error("工作区版本或内容不兼容");
  const workspaces: WorkspaceSession["workspaces"] = {};
  for (const [family, value] of Object.entries(raw.workspaces)) {
    const draft = migrateDraft(value);
    if (draft.family !== family) throw new Error("工作区家族不匹配");
    workspaces[draft.family] = draft;
  }
  if (!workspaces[raw.activeFamily]) throw new Error("活动工作区缺失");
  return { schema: 1, activeFamily: raw.activeFamily, workspaces };
}
export function withIds(d: Draft): Draft {
  let pool = [...(d.colorPool ?? [])].filter((c) =>
    (BOX_COLORS as readonly string[]).includes(c),
  );
  const boxes = d.boxes.map((b) => {
    let color = b.color;
    if (!color) {
      const drawn = drawBoxColor(pool);
      color = drawn.color;
      pool = drawn.remaining;
    }
    return { ...b, uid: b.uid ?? crypto.randomUUID(), color };
  });
  return {
    ...d,
    colorPool: pool,
    refs: d.refs.map((r) => ({ ...r, uid: r.uid ?? crypto.randomUUID() })),
    boxes,
  };
}
export function scaleRect(
  r: Rect,
  from: { w: number; h: number },
  to: { w: number; h: number },
): Rect {
  return {
    x: (r.x / from.w) * to.w,
    y: (r.y / from.h) * to.h,
    w: (r.w / from.w) * to.w,
    h: (r.h / from.h) * to.h,
  };
}
export function resizeCanvas(d: Draft, canvas: Draft["canvas"]): Draft {
  return {
    ...d,
    canvas,
    boxes: d.boxes.map((b) => ({
      ...b,
      rect: scaleRect(b.rect, d.canvas, canvas),
    })),
  };
}
export function renameBox(d: Draft, uid: string, id: string): Draft {
  const old = d.boxes.find((b) => b.uid === uid);
  if (!old) return d;
  return {
    ...d,
    prompt: d.prompt.split("<" + old.id + ">").join("<" + id + ">"),
    boxes: d.boxes.map((b) => (b.uid === uid ? { ...b, id } : b)),
  };
}
export function reorderRefs(d: Draft, refs: WorkingImage[]): Draft {
  const replacements = new Map(
    d.refs.map((r, i) => [
      "ref_image_" + i,
      refs.findIndex((n) => n.uid === r.uid),
    ]),
  );
  return {
    ...d,
    refs,
    prompt: d.prompt.replace(/<ref_image_(\d+)>/g, (tag, n: string) => {
      const index = replacements.get("ref_image_" + n);
      return index !== undefined && index >= 0
        ? "<ref_image_" + index + ">"
        : tag;
    }),
  };
}
export function sentSize(r: WorkingImage, enabled: boolean, edge: number) {
  const k = enabled ? Math.min(1, edge / Math.max(r.width, r.height)) : 1;
  return {
    w: Math.max(1, Math.round(r.width * k)),
    h: Math.max(1, Math.round(r.height * k)),
  };
}
export function validateDraft(d: Draft): string[] {
  const errors = validateModel(d);
  if (
    d.compressEnabled &&
    (!Number.isInteger(d.maxInputEdge) ||
      d.maxInputEdge < 256 ||
      d.maxInputEdge > 8192)
  )
    errors.push("压缩长边上限须为 256–8192 的整数");
  if (d.family === "flux" && ["bfl", "comfy"].includes(d.provider))
    for (const r of d.refs) {
      const s = sentSize(r, d.compressEnabled, d.maxInputEdge);
      if (s.w < 256 || s.h < 256 || s.w * s.h > 16_000_000)
        errors.push(
          r.name +
            " 发送尺寸 " +
            s.w +
            "×" +
            s.h +
            " 不符合 BFL：每边至少 256px、面积至多 16MP。请提高压缩上限或替换图片。",
        );
    }
  return errors;
}
export function changeRole(b: Box, role: Box["role"], d: Draft): Box {
  const source =
    d.refs.find((r) => r.uid === b.sourceId) ??
    d.refs.find((r) => r.uid === d.baseId) ??
    d.refs[0];
  return {
    ...b,
    role,
    sourceId: source?.uid,
    srcRect:
      ["move", "anchor", "remove"].includes(role) && source
        ? (b.srcRect ??
          scaleRect(b.rect, d.canvas, { w: source.width, h: source.height }))
        : undefined,
  };
}
export function outputEstimate(d: Draft) {
  if (fieldsFor(d).size) return gptSize(d.params.size) ?? { w: 1024, h: 1024 };
  if (fieldsFor(d).width)
    return { w: d.params.width ?? 1024, h: d.params.height ?? 1024 };
  const edge =
    (
      {
        "768": 768,
        "1K": 1024,
        "1.5K": 1536,
        "2K": 2048,
        "4K": 4096,
      } as Record<string, number>
    )[d.params.resolution ?? "1K"] ?? 1024;
  const ratio = d.canvas.w / d.canvas.h;
  return {
    w: Math.round((edge * Math.sqrt(ratio)) / 16) * 16,
    h: Math.round(edge / Math.sqrt(ratio) / 16) * 16,
  };
}
