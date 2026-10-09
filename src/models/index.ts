import type { Draft, GenerateRequestPayload, LayoutRegion } from "../lib/types";
import { m } from "../i18n";
import { composePrompt } from "./flux/protocol";
import { routeFor, validateFields, pickParams, defaultsFor } from "./catalog";
import { validateGpt } from "./gpt";
import { validateQwen } from "./qwen";
import { validateImage } from "./image";
import { referenceInstruction } from "./referenceInstructions";
import { gptSize } from "./gpt";
import { regionsEnabled } from "./flux/layout";

export function compileDraft(d: Draft) {
  if (!d.prompt.trim())
    return { finalPrompt: "", rows: [], error: m.error_prompt_required() };
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
    error: d.prompt.trim() ? null : m.error_prompt_required(),
  };
}
/** Limits apply to the compiled instruction, including reference roles and regions. */
export function promptLength(d: Draft) {
  const length = Array.from(compileDraft(d).finalPrompt).length;
  const route = routeFor(d);
  const min = route?.minPrompt ?? 1,
    max = route?.maxPrompt ?? 32000;
  const error =
    length > max
      ? m.error_prompt_too_long({ max })
      : length > 0 && length < min
        ? m.error_prompt_too_short({ min })
        : null;
  return { length, min, max, error };
}
const validators = {
  flux: () => [],
  gpt: validateGpt,
  qwen: validateQwen,
  gemini: validateImage,
  seedream: validateImage,
  grok: validateImage,
};
export function validateModel(d: Draft) {
  const errors = [...validateFields(d), ...validators[d.family](d)];
  if (
    [...d.prompt.matchAll(/<ref_image_(\d+)>/g)].some(
      (match) => Number(match[1]) >= d.refs.length,
    )
  )
    errors.push(m.error_missing_image_tag());
  if (d.intent === "edit" && !d.refs.length) errors.push(m.error_need_main_image());
  if (d.intent === "edit" && routeFor(d)?.maxRefs === 0)
    errors.push(m.error_edit_needs_provider());
  if (d.intent === "create" && d.mask) errors.push(m.error_mask_needs_edit_mode());
  if (d.intent === "edit" && d.baseId && d.refs[0]?.uid !== d.baseId)
    errors.push(m.error_main_must_be_first());
  const prompt = promptLength(d);
  if (prompt.error) errors.push(prompt.error);
  if (d.family !== "flux" && d.boxes.length && d.layoutEnabled !== false)
    errors.push(m.error_regions_unsupported());
  if (d.family === "flux" && d.provider === "runware") {
    if (!d.refs.length && !d.boxes.length)
      errors.push(m.error_runware_place());
    if (!d.refs.length && d.params.aspectRatio === "auto")
      errors.push(m.error_runware_aspect());
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
  if (!route) throw new Error(m.error_route_unavailable());
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
  if (params.promptExtend === false) {
    delete params.promptExtendMode;
    delete params.enableThinking;
  }
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
