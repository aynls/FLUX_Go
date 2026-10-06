import type {
  Box,
  Draft,
  FamilyId,
  Preferences,
  Rect,
  WorkingImage,
  WorkspaceSession,
  TaskIntent,
  WorkspaceKey,
} from "./types";
import { DEFAULT_PARAMS, phantomSize } from "./params";
import { BOX_COLORS, drawBoxColor } from "./boxColors";
import {
  defaultsFor,
  familyById,
  fieldsFor,
  modelById,
  providers,
  catalog,
  routeFor,
  changeRoute,
} from "../models/catalog";
import { validateModel } from "../models";
import { gptSize } from "../models/gpt";

export const DEFAULT_PREFERENCES: Preferences = {
  defaultFamily: "flux",
  sidebarWidthPercent: 25,
  referenceSidebarWidth: 238,
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
  const saved = p.familyDefaults?.[family];
  const modelId =
    modelById(saved?.modelId ?? "")?.family === family
      ? saved!.modelId
      : familyById(family).defaultModel;
  const preferredProvider = saved?.provider ?? p.provider;
  const provider = modelById(modelId)?.routes[preferredProvider]
    ? preferredProvider
    : "openrouter";
  const params = {
    ...defaultsFor(modelId, provider),
    ...(family === "flux" ? p.params : {}),
    ...saved?.params,
  };
  return {
    schema: 4,
    intent: "create",
    showBase: true,
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

export function readDraft(value: unknown): Draft {
  if (!value || typeof value !== "object") throw new Error("草稿内容无效");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== 4) throw new Error("草稿版本不兼容");
  const family = raw.family;
  const modelId = raw.modelId;
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
    (raw.intent !== "create" && raw.intent !== "edit") ||
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
  const draft = withIds({
    ...newDraft(DEFAULT_PREFERENCES, model.family),
    ...raw,
    schema: 4,
    family: model.family,
    modelId: model.id,
    params: {
      ...defaultsFor(model.id, raw.provider as Draft["provider"]),
      ...raw.params,
    },
    mask: (raw.mask ?? null) as WorkingImage | null,
  } as Draft);
  return taskIntent(draft) === "edit" && draft.refs.length
    ? setPrimaryImage(
        draft,
        draft.refs.find((r) => r.uid === draft.baseId)?.uid ??
          draft.refs[0].uid!,
      )
    : draft;
}
export function readSession(value: unknown): WorkspaceSession | null {
  if (value == null) return null;
  const raw = value as Partial<WorkspaceSession>;
  if (
    raw.schema !== 2 ||
    !raw.tasks ||
    !["create", "edit"].includes(raw.activeIntent ?? "")
  )
    throw new Error("工作区版本或内容不兼容");
  const tasks: WorkspaceSession["tasks"] = {};
  for (const [key, value] of Object.entries(raw.tasks)) {
    const draft = readDraft(value);
    if (draft.intent !== key) throw new Error("工作区任务不匹配");
    tasks[draft.intent] = draft;
  }
  if (!tasks[raw.activeIntent!]) throw new Error("活动工作区缺失");
  return { schema: 2, activeIntent: raw.activeIntent!, tasks };
}
/** A model change keeps the task's creative content and restores that route's controls. */
export function changeFamily(
  d: Draft,
  family: FamilyId,
  prefs = DEFAULT_PREFERENCES,
): Draft {
  if (family === d.family) return d;
  const fallback = newDraft(prefs, family);
  const route = d.familyRoutes?.[family] ?? {
    modelId: fallback.modelId,
    provider: fallback.provider,
  };
  const key = route.modelId + ":" + route.provider;
  const initialParams = d.familyRoutes?.[family]
    ? defaultsFor(route.modelId, route.provider)
    : fallback.params;
  const next = changeRoute(
    { ...d, routeSettings: { [key]: initialParams, ...d.routeSettings } },
    route.provider,
    route.modelId,
  );
  const size = outputEstimate(next);
  return size.w > 0 && size.h > 0 ? resizeCanvas(next, size) : next;
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
export function sourceOnCanvas(
  r: Rect,
  source: WorkingImage,
  canvas: Draft["canvas"],
): Rect {
  const scale = Math.min(canvas.w / source.width, canvas.h / source.height);
  return {
    x: (canvas.w - source.width * scale) / 2 + r.x * scale,
    y: (canvas.h - source.height * scale) / 2 + r.y * scale,
    w: r.w * scale,
    h: r.h * scale,
  };
}
export function canvasToSource(
  r: Rect,
  source: WorkingImage,
  canvas: Draft["canvas"],
): Rect {
  const scale = Math.min(canvas.w / source.width, canvas.h / source.height);
  const x = Math.min(
    source.width - 1,
    Math.max(0, (r.x - (canvas.w - source.width * scale) / 2) / scale),
  );
  const y = Math.min(
    source.height - 1,
    Math.max(0, (r.y - (canvas.h - source.height * scale) / 2) / scale),
  );
  return {
    x,
    y,
    w: Math.max(1, Math.min(source.width - x, r.w / scale)),
    h: Math.max(1, Math.min(source.height - y, r.h / scale)),
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
export function taskIntent(d: Draft): TaskIntent {
  return d.intent;
}
export function workspaceKey(d: Draft): WorkspaceKey {
  return taskIntent(d);
}
export function primaryImage(d: Draft) {
  if (taskIntent(d) !== "edit") return null;
  return d.refs.find((r) => r.uid === d.baseId) ?? d.refs[0] ?? null;
}
/** Changing the primary image changes API order and remaps exact image tags together. */
export function setPrimaryImage(d: Draft, uid: string): Draft {
  const image = d.refs.find((r) => r.uid === uid);
  if (!image) throw new Error("主图不存在");
  if (d.mask && d.refs[0]?.uid !== uid)
    throw new Error("请先移除当前主图的蒙版，再替换主图");
  const next = {
    ...reorderRefs(d, [image, ...d.refs.filter((r) => r.uid !== uid)]),
    intent: "edit" as const,
    baseId: uid,
    showBase: true,
    params: {
      ...d.params,
      ...(d.intent === "create" &&
      fieldsFor(d).aspectRatio?.values?.includes("auto")
        ? { aspectRatio: "auto" }
        : {}),
    },
  };
  return next.params.aspectRatio === "auto"
    ? resizeCanvas(next, { w: image.width, h: image.height })
    : next;
}
export function setTaskIntent(d: Draft, intent: TaskIntent): Draft {
  if (intent === "create" && d.mask)
    throw new Error("请先移除编辑蒙版，再生成新画面");
  if (intent === "edit" && d.refs.length)
    return setPrimaryImage(
      d,
      primaryImage({ ...d, intent })?.uid ?? d.refs[0].uid!,
    );
  return { ...d, intent, baseId: intent === "create" ? null : d.baseId };
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
  const key = routeFor(d)?.dimensionsKey;
  const dimensions =
    key &&
    catalog.imageDimensions[key]?.[d.params.resolution ?? "1K"]?.[
      d.params.aspectRatio ?? "1:1"
    ];
  if (dimensions) return { w: dimensions[0], h: dimensions[1] };
  if (fieldsFor(d).size) return gptSize(d.params.size) ?? { w: 1024, h: 1024 };
  if (fieldsFor(d).width && d.params.width != null && d.params.height != null)
    return { w: d.params.width ?? 1024, h: d.params.height ?? 1024 };
  const edge =
    (
      {
        "512": 512,
        "0.5K": 512,
        "768": 768,
        "1K": 1024,
        "1.5K": 1536,
        "2K": 2048,
        "3K": 3072,
        "4K": 4096,
      } as Record<string, number>
    )[d.params.resolution ?? "1K"] ?? 1024;
  const automaticReference = d.refs[0];
  const aspect = d.params.aspectRatio;
  const pair =
    aspect && aspect !== "auto" ? aspect.split(":").map(Number) : null;
  const ratio =
    pair?.length === 2 && pair.every((v) => v > 0)
      ? pair[0] / pair[1]
      : aspect === "auto" && automaticReference
        ? automaticReference.width / automaticReference.height
        : d.canvas.w / d.canvas.h;
  return {
    w: Math.round((edge * Math.sqrt(ratio)) / 16) * 16,
    h: Math.round(edge / Math.sqrt(ratio) / 16) * 16,
  };
}
