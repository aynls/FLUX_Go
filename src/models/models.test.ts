import { expect, test } from "bun:test";
import {
  newDraft,
  DEFAULT_PREFERENCES,
  readDraft,
  readSession,
  validateDraft,
  changeFamily,
} from "../lib/workspace";
import { buildRequest, compileDraft } from ".";
import { changeRoute } from "./catalog";
import { setPrimaryImage } from "../lib/workspace";
test("disabled composition keeps draft regions but excludes them from FLUX requests", () => {
  const d = {
    ...newDraft(),
    prompt: "a forest",
    layoutEnabled: true,
    boxes: [
      {
        id: "tree",
        role: "place" as const,
        desc: "oak tree",
        rect: { x: 0, y: 0, w: 512, h: 512 },
      },
    ],
  };
  expect(buildRequest(d, []).regions).toHaveLength(1);
  const disabled = { ...d, layoutEnabled: false };
  expect(buildRequest(disabled, []).regions).toHaveLength(0);
  expect(compileDraft(disabled).finalPrompt).not.toContain("bbox");
  expect(disabled.boxes).toHaveLength(1);
  expect(
    buildRequest({ ...disabled, provider: "runware" }, []).regions,
  ).toHaveLength(1);
});
test("FLUX keeps independent source and target coordinates for structured providers", () => {
  const d = {
    ...newDraft(),
    provider: "runware" as const,
    prompt: "Move <star>",
    refs: [
      { uid: "source", dataUrl: "x", width: 500, height: 1000, name: "star" },
    ],
    boxes: [
      {
        id: "star",
        role: "move" as const,
        sourceId: "source",
        desc: "a star",
        rect: { x: 0, y: 0, w: 512, h: 512 },
        srcRect: { x: 250, y: 500, w: 250, h: 500 },
      },
    ],
  };
  const req = buildRequest(d, ["x"]);
  expect(req.regions).toEqual([
    {
      id: "star",
      description: "a star",
      referenceIndex: 0,
      sourceBox: [500, 500, 1000, 1000],
      targetBox: [0, 0, 500, 500],
    },
  ]);
  expect(req.params.version).toBeUndefined();
  expect(req.instruction).toContain("Move <star>");
});
test("GPT route differences, size bounds and transparency are validated", () => {
  const base = newDraft(DEFAULT_PREFERENCES, "gpt"),
    comfy = changeRoute(base, "comfy"),
    runware = changeRoute(comfy, "runware");
  expect(validateDraft(comfy)).toEqual([]);
  expect(validateDraft(runware)).toEqual([]);
  expect(
    validateDraft({ ...comfy, params: { ...comfy.params, size: "3840x2160" } }),
  ).toEqual([]);
  expect(
    validateDraft({
      ...comfy,
      params: { ...comfy.params, size: "1025x1024" },
    }).join(),
  ).toContain("16");
  expect(
    validateDraft({
      ...comfy,
      params: {
        ...comfy.params,
        background: "transparent",
        outputFormat: "jpeg",
      },
    }).join(),
  ).toContain("透明背景");
  expect(
    buildRequest({ ...comfy, prompt: "test" }, []).params.outputCompression,
  ).toBeUndefined();
});
test("switching routes retains masks but blocks unsupported or mismatched masks", () => {
  const im = {
    uid: "first",
    dataUrl: "data:image/png;base64,YQ==",
    width: 1024,
    height: 1024,
    name: "base",
  };
  const d = {
    ...changeRoute(newDraft(DEFAULT_PREFERENCES, "gpt"), "comfy"),
    intent: "edit" as const,
    refs: [im],
    mask: { ...im, name: "mask" },
  };
  expect(validateDraft(d)).toEqual([]);
  const incompatible = changeRoute(d, "openrouter");
  expect(incompatible.mask).toBe(d.mask);
  expect(validateDraft(incompatible).join()).toContain("不支持蒙版");
  expect(validateDraft({ ...d, mask: { ...im, width: 512 } }).join()).toContain(
    "尺寸",
  );
});
test("Qwen editing mode and route area limits are enforced", () => {
  const d = changeRoute(newDraft(DEFAULT_PREFERENCES, "qwen"), "comfy");
  const big = { ...d, params: { ...d.params, width: 2560, height: 2560 } };
  expect(validateDraft(big)).toEqual([]);
  expect(validateDraft(changeRoute(big, "runware")).join()).toContain(
    "尺寸面积",
  );
  expect(
    validateDraft({
      ...d,
      refs: [{ uid: "a", dataUrl: "", width: 512, height: 512, name: "a" }],
      params: { ...d.params, promptExtendMode: "agent" },
    }).join(),
  ).toContain("direct");
  const request = buildRequest(
    { ...d, prompt: "test", params: { ...d.params, promptExtend: false } },
    [],
  );
  expect(request.params.promptExtendMode).toBeUndefined();
});
test("task sessions restore content and reject incompatible or mismatched data", () => {
  const create = { ...newDraft(), prompt: "new work" };
  const edit = {
    ...newDraft(DEFAULT_PREFERENCES, "gpt"),
    intent: "edit" as const,
    prompt: "edit work",
  };
  const session = readSession({
    schema: 2,
    activeIntent: "edit",
    tasks: { create, edit },
  });
  expect(session?.tasks.create?.prompt).toBe("new work");
  expect(session?.tasks.edit?.prompt).toBe("edit work");
  expect(session?.activeIntent).toBe("edit");
  expect(() =>
    readSession({ schema: 2, activeIntent: "create", tasks: { create: edit } }),
  ).toThrow("工作区任务不匹配");
  expect(() => readSession({ schema: 999 })).toThrow();
  expect(() => readDraft({ ...create, schema: 3 })).toThrow();
});
test("restoring a main image order remaps exact image tags together", () => {
  const draft = {
    ...newDraft(),
    intent: "edit" as const,
    prompt: "Edit <ref_image_0> using <ref_image_1>",
    baseId: "main",
    refs: [
      {
        uid: "reference",
        name: "reference",
        dataUrl: "a",
        width: 1024,
        height: 1024,
      },
      { uid: "main", name: "main", dataUrl: "b", width: 1024, height: 1024 },
    ],
  };
  const restored = readDraft(JSON.parse(JSON.stringify(draft)));
  expect(restored.baseId).toBe("main");
  expect(
    buildRequest(
      restored,
      restored.refs.map((r) => r.dataUrl),
    ).images,
  ).toEqual(["b", "a"]);
  expect(restored.prompt).toBe("Edit <ref_image_1> using <ref_image_0>");
  expect(compileDraft(restored).finalPrompt).toContain(
    "Edit <ref_image_0> as the primary image",
  );
});
test("changing model families retains creative content and restores independent route values", () => {
  const source = {
    ...changeRoute(newDraft(undefined, "gpt"), "comfy"),
    intent: "edit" as const,
    prompt: "replace the sky",
    baseId: "main",
    refs: [
      { uid: "main", name: "main", width: 1024, height: 1024, dataUrl: "main" },
    ],
    mask: { name: "mask", width: 1024, height: 1024, dataUrl: "mask" },
    repeatCount: 4,
  };
  source.params = { ...source.params, quality: "high", outputCompression: 82 };
  const gemini = changeFamily(source, "gemini");
  expect(gemini.refs).toEqual(source.refs);
  expect(gemini.mask).toEqual(source.mask);
  expect(gemini.prompt).toBe(source.prompt);
  expect(gemini.baseId).toBe("main");
  expect(gemini.repeatCount).toBe(4);
  expect(validateDraft(gemini).join()).toContain("不支持蒙版");
  const google = changeRoute(gemini, "google", "gemini-nano-banana-2.1");
  const gpt = changeFamily({ ...google, prompt: "new instruction" }, "gpt");
  expect(gpt.provider).toBe("comfy");
  expect(gpt.params).toEqual(source.params);
  expect(gpt.prompt).toBe("new instruction");
  expect(gpt.mask).toEqual(source.mask);
  const back = changeFamily(gpt, "gemini");
  expect(back.modelId).toBe("gemini-nano-banana-2.1");
  expect(back.provider).toBe("google");
});
test("unsupported regions block until explicitly paused and return intact", () => {
  const d = {
    ...newDraft(),
    prompt: "an oak",
    layoutEnabled: true,
    boxes: [
      {
        id: "tree",
        role: "place" as const,
        desc: "oak",
        rect: { x: 0, y: 0, w: 512, h: 512 },
      },
    ],
  };
  const next = changeFamily(d, "gemini");
  expect(validateDraft(next).join()).toContain("此模型不支持区域");
  const paused = { ...next, layoutEnabled: false };
  expect(validateDraft(paused)).toEqual([]);
  expect(buildRequest(paused, []).regions).toEqual([]);
  const back = changeFamily(paused, "flux");
  expect(back.boxes).toEqual(d.boxes);
  expect(buildRequest(back, []).regions).toEqual([]);
  expect(
    buildRequest({ ...back, layoutEnabled: true }, []).regions,
  ).toHaveLength(1);
});
test("route round trips restore original values and preserve inactive parameters", () => {
  let d = changeRoute(newDraft(DEFAULT_PREFERENCES, "qwen"), "runware");
  d = { ...d, params: { ...d.params, count: 20, negativePrompt: "no text" } };
  const other = changeRoute(d, "openrouter");
  expect(other.params.count).toBe(1);
  expect(
    buildRequest({ ...other, prompt: "test" }, []).params.negativePrompt,
  ).toBeUndefined();
  expect(changeRoute(other, "runware").params.count).toBe(20);
  expect(changeRoute(other, "runware").params.negativePrompt).toBe("no text");
  expect(readDraft(JSON.parse(JSON.stringify(other))).routeSettings).toEqual(
    other.routeSettings,
  );
});
test("GPT reference tags follow primary changes and compile to native image numbering", () => {
  const d = {
    ...newDraft(DEFAULT_PREFERENCES, "gpt"),
    prompt: "Edit <ref_image_1> using <ref_image_0>",
    refs: [
      { uid: "a", name: "a", dataUrl: "a", width: 1024, height: 1024 },
      { uid: "b", name: "b", dataUrl: "b", width: 1024, height: 1024 },
    ],
  };
  const next = setPrimaryImage(d, "b");
  expect(
    buildRequest(
      next,
      next.refs.map((r) => r.dataUrl),
    ).finalPrompt,
  ).toContain("Edit image 1 using image 2");
  expect(validateDraft({ ...next, refs: [] }).join()).toContain("不存在的图片");
});
