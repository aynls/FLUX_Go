import { expect, test } from "bun:test";
import { buildRequest, validateModel } from ".";
import { changeRoute, defaultsFor, fieldsFor, modelByAnyId } from "./catalog";
import { newDraft, readDraft, outputEstimate, changeFamily } from "../lib/workspace";
import type { ProviderId, WorkingImage } from "../lib/types";

const reference = (uid: string) => ({ uid, dataUrl: "data:image/png;base64,AA==", width: 1024, height: 1024, name: uid, purpose: "reference" } as WorkingImage);
const grok = (provider: ProviderId) => {
  const d = changeRoute(newDraft(undefined, "grok"), provider);
  return { ...d, params: defaultsFor(d.modelId, provider), prompt: "A small otter reading a book" };
};

test("Grok defaults and wire IDs resolve on all four providers", () => {
  for (const provider of ["openrouter", "runware", "comfy", "xai"] as const) {
    const d = grok(provider);
    expect(validateModel(d)).toEqual([]);
    expect(readDraft(JSON.parse(JSON.stringify(d))).family).toBe("grok");
    const defaults = defaultsFor(d.modelId, provider);
    delete defaults.outputCompression;
    expect(buildRequest(d, []).params).toEqual(defaults);
    expect(fieldsFor(d).seed).toBeUndefined();
    expect(fieldsFor(d).quality.values).toEqual(provider === "xai" ? ["auto", "low", "medium"] : ["low", "medium"]);
  }
  for (const id of ["xai/grok-imagine-image-2.0", "x-ai/grok-imagine-image-2.0", "xai:grok-imagine@image-2.0"])
    expect(modelByAnyId(id)?.family).toBe("grok");
});

test("Grok restores route settings and retains edit inputs across restrictive routes", () => {
  const official = grok("xai");
  official.intent = "edit";
  official.refs = [reference("main"), reference("style")];
  official.baseId = "main";
  official.params = { ...official.params, resolution: "2K", aspectRatio: "5:2", quality: "auto" };
  const comfy = changeRoute(official, "comfy");
  expect(comfy.refs).toEqual(official.refs);
  expect(validateModel(comfy).join()).toContain("仅支持文生图");
  expect(comfy.params.quality).toBe("medium");
  expect(comfy.params.aspectRatio).toBe("1:1");
  expect(changeRoute(comfy, "xai").params).toEqual(official.params);
  expect(buildRequest(official, ["main-url", "style-url"]).images).toEqual(["main-url", "style-url"]);
  const flux = changeFamily(official, "flux");
  expect(changeFamily(flux, "grok").params).toEqual(official.params);
});

test("Grok enforces route reference limits, unsupported masks and automatic Runware sizes", () => {
  for (const [provider, max] of [["openrouter", 3], ["runware", 3], ["xai", 5]] as const) {
    const d = grok(provider);
    d.refs = Array.from({length: max}, (_, i) => reference(String(i)));
    expect(validateModel(d)).toEqual([]);
    d.refs.push(reference("overflow"));
    expect(validateModel(d).join()).toContain("最多");
  }
  const d = grok("runware");
  d.params = { ...d.params, resolution: "2K", aspectRatio: "9:20" };
  expect(outputEstimate(d)).toEqual({w: 1440, h: 3200});
  d.params.aspectRatio = "auto";
  expect(validateModel(d).join()).toContain("自动比例需要参考图");
  d.refs = [reference("main")];
  expect(validateModel(d)).toEqual([]);
  d.mask = reference("mask");
  expect(validateModel(d).join()).toContain("不支持蒙版");
});

test("Grok only compiles supported parameters after switching from GPT or Runware", () => {
  let d = newDraft(undefined, "gpt");
  d.params = { ...d.params, quality: "high", background: "transparent", moderation: "low" };
  d = changeFamily(d, "grok");
  d.prompt = "An otter";
  expect(buildRequest(d, []).params.background).toBeUndefined();
  expect(buildRequest(d, []).params.moderation).toBeUndefined();
  d = changeRoute(d, "runware");
  d.params.outputFormat = "webp";
  const official = buildRequest(changeRoute(d, "xai"), []);
  expect(official.params.outputFormat).toBeUndefined();
  expect(official.params.outputCompression).toBeUndefined();
});
