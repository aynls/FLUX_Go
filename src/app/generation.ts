import { generate } from "../lib/api";
import { downscaleDataUrl, imageSize } from "../lib/image";
import { buildRequest } from "../models";
import { primaryImage, taskIntent } from "../lib/workspace";
import type {
  Draft,
  GenerateOutput,
  HistoryItem,
  WorkingImage,
  GenerationProgress,
} from "../lib/types";

export interface SavedResult {
  image: WorkingImage;
  selectedIndex: number;
  out: GenerateOutput;
  snapshot: Draft;
  item: HistoryItem;
  files: { kind: string; name: string; data: string }[];
  saved: boolean;
}
export function getResultBase(result: SavedResult | null) {
  return result ? primaryImage(result.snapshot) : null;
}
/** One immutable snapshot, one paid submission, all output images retained. */
export async function executeGeneration(
  snapshot: Draft,
  onProgress?: (progress: GenerationProgress) => void,
): Promise<SavedResult> {
  onProgress?.({ phase: "preparing" });
  const images = await Promise.all(
    snapshot.refs.map((r) =>
      snapshot.compressEnabled
        ? downscaleDataUrl(r.dataUrl, snapshot.maxInputEdge)
        : Promise.resolve(r.dataUrl),
    ),
  );
  const mask = snapshot.mask
    ? snapshot.compressEnabled
      ? await downscaleDataUrl(snapshot.mask.dataUrl, snapshot.maxInputEdge)
      : snapshot.mask.dataUrl
    : undefined;
  onProgress?.({ phase: "waiting" });
  const request = buildRequest(snapshot, images, mask);
  const out = await generate(request, onProgress);
  if (!out.images[0]) throw new Error("服务返回成功，但没有图片");
  const image: WorkingImage = {
    uid: crypto.randomUUID(),
    dataUrl: out.images[0].dataUrl,
    ...(await imageSize(out.images[0].dataUrl)),
    name: "生成结果",
  };
  const { refs, mask: originalMask, ...recipe } = snapshot;
  const item: HistoryItem = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    provider: out.provider,
    model: out.model,
    mode: taskIntent(snapshot) === "edit" ? "edit" : "t2i",
    prompt: snapshot.prompt,
    finalPrompt: out.finalPrompt,
    params: { ...request.params },
    boxes: snapshot.boxes,
    canvasWidth: snapshot.canvas.w,
    canvasHeight: snapshot.canvas.h,
    inputFiles: [],
    resultFiles: [],
    maskFile: null,
    thumb: null,
    usage: out.usage,
    cost: out.usage?.cost ?? null,
    status: "ok",
    recipe: {
      ...recipe,
      refNames: refs.map((r) => r.name),
      refIds: refs.map((r) => r.uid!),
      refPurposes: refs.map((r) => r.purpose),
      refNotes: refs.map((r) => r.note),
      maskName: originalMask?.name,
    },
  };
  const files = [
    ...refs.map((r, i) => ({
      kind: "input",
      name: "input_" + i,
      data: r.dataUrl,
    })),
    ...out.images.map((im, i) => ({
      kind: "result",
      name: "result_" + i,
      data: im.dataUrl,
    })),
    ...(originalMask
      ? [{ kind: "mask", name: "mask", data: originalMask.dataUrl }]
      : []),
  ];
  return { image, selectedIndex: 0, out, snapshot, item, files, saved: false };
}
