import type { Draft, GenerateRequestPayload, LayoutRegion } from "../lib/types";
import { composePrompt } from "../lib/protocol";
import { routeFor, validateFields, pickParams, defaultsFor } from "./catalog";
import { validateGpt } from "./gpt";
import { validateQwen } from "./qwen";

export function compileDraft(d: Draft) {
  if (d.family === "flux") {
    const result = composePrompt({
      mode: d.refs.length ? "edit" : "t2i",
      instruction: d.prompt,
      boxes: d.boxes,
      iw: d.canvas.w,
      ih: d.canvas.h,
      refs: d.refs,
    });
    return d.provider === "runware" && !result.error
      ? { ...result, finalPrompt: d.prompt.trim() }
      : result;
  }
  return {
    finalPrompt: d.prompt.trim(),
    rows: [],
    error: d.prompt.trim() ? null : "请输入提示词",
  };
}
const validators = { flux: () => [], gpt: validateGpt, qwen: validateQwen };
export function validateModel(d: Draft) {
  const errors = [...validateFields(d), ...validators[d.family](d)];
  const length = Array.from(compileDraft(d).finalPrompt).length;
  if (length > 32000) errors.push("编译后的提示词超过 32000 字符");
  if (length > 0 && length < (routeFor(d)?.minPrompt ?? 1))
    errors.push(`此路由提示词至少需要 ${routeFor(d)?.minPrompt} 个字符`);
  if (d.family !== "flux" && d.boxes.length)
    errors.push("此模型不支持 FLUX 区域协议，请使用对应模型工作区");
  if (d.family === "flux" && d.provider === "runware") {
    if (!d.refs.length && !d.boxes.length)
      errors.push("Runware FLUX 文生图需要至少一个放置区域，请在画布上画框");
    if (!d.refs.length && d.params.aspectRatio === "auto")
      errors.push("Runware FLUX 文生图需要明确的宽高比");
  }
  return errors;
}
export function buildRequest(
  d: Draft,
  images: string[],
  mask?: string,
): GenerateRequestPayload {
  const compiled = compileDraft(d);
  if (compiled.error) throw new Error(compiled.error);
  const route = routeFor(d);
  if (!route) throw new Error("该模型与供应商组合不可用");
  const regions: LayoutRegion[] =
    d.family === "flux"
      ? compiled.rows.map((row) =>
          "bbox" in row
            ? {
                id: row.id,
                description: row.desc,
                referenceIndex: null,
                sourceBox: null,
                targetBox: row.bbox,
              }
            : {
                id: row.id,
                description: row.desc,
                referenceIndex: row.from ? Number(row.from.slice(10)) : null,
                sourceBox: row.src_bbox,
                targetBox: row.tgt_bbox,
              },
        )
      : [];
  const params = pickParams(d.modelId, d.provider, {
    ...defaultsFor(d.modelId, d.provider),
    ...d.params,
  });
  if (params.outputFormat === "png") delete params.outputCompression;
  if (params.promptExtend === false) delete params.promptExtendMode;
  return {
    provider: d.provider,
    model: d.modelId,
    finalPrompt: compiled.finalPrompt,
    instruction: d.prompt.trim(),
    regions,
    images,
    mask,
    params,
    requestId: crypto.randomUUID(),
  };
}
