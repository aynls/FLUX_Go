import type { Draft, GenerateRequestPayload, LayoutRegion } from "../lib/types";
import { composePrompt } from "../lib/protocol";
import { routeFor, validateFields, pickParams, defaultsFor } from "./catalog";
import { validateGpt } from "./gpt";
import { validateQwen } from "./qwen";
import { validateImage } from "./image";
import { referenceInstruction } from "./referenceInstructions";
import { gptSize } from "./gpt";
import { regionsEnabled } from "./flux/layout";

export function compileDraft(d: Draft) {
  if (!d.prompt.trim())
    return { finalPrompt: "", rows: [], error: "请输入提示词" };
  const instruction = referenceInstruction(d);
  if (d.family === "flux") {
    const result = composePrompt({
      mode: d.refs.length ? "edit" : "t2i",
      instruction,
      boxes: regionsEnabled(d) ? d.boxes : [],
      iw: d.canvas.w,
      ih: d.canvas.h,
      refs: d.refs,
    });
    return d.provider === "runware" && !result.error
      ? { ...result, finalPrompt: instruction }
      : result;
  }
  return {
    finalPrompt: instruction,
    rows: [],
    error: d.prompt.trim() ? null : "请输入提示词",
  };
}
const validators = {
  flux: () => [],
  gpt: validateGpt,
  qwen: validateQwen,
  gemini: validateImage,
  seedream: validateImage,
};
export function validateModel(d: Draft) {
  const errors = [...validateFields(d), ...validators[d.family](d)];
  if (
    [...d.prompt.matchAll(/<ref_image_(\d+)>/g)].some(
      (match) => Number(match[1]) >= d.refs.length,
    )
  )
    errors.push("提示词引用了不存在的图片，请更新图片标签");
  if (d.intent === "edit" && !d.refs.length) errors.push("请添加编辑主图");
  if (d.intent === "create" && d.mask) errors.push("编辑蒙版需要编辑图片模式");
  if (d.intent === "edit" && d.baseId && d.refs[0]?.uid !== d.baseId)
    errors.push("主图须位于图片 1，请重新指定主图");
  const length = Array.from(compileDraft(d).finalPrompt).length;
  const maxPrompt = routeFor(d)?.maxPrompt ?? 32000;
  if (length > maxPrompt) errors.push(`编译后的提示词超过 ${maxPrompt} 字符`);
  if (length > 0 && length < (routeFor(d)?.minPrompt ?? 1))
    errors.push(`此路由提示词至少需要 ${routeFor(d)?.minPrompt} 个字符`);
  if (d.family !== "flux" && d.boxes.length && d.layoutEnabled !== false)
    errors.push("此模型不支持区域，请暂不使用区域或切换到 FLUX");
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
  const size = gptSize(params.size);
  if (size) params.size = `${size.w}x${size.h}`;
  if (params.promptExtend === false) delete params.promptExtendMode;
  return {
    provider: d.provider,
    model: d.modelId,
    finalPrompt: compiled.finalPrompt,
    instruction: referenceInstruction(d),
    regions,
    images,
    mask,
    params,
    requestId: crypto.randomUUID(),
  };
}
