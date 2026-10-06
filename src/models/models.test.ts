import { expect, test } from "bun:test";
import {
  newDraft,
  DEFAULT_PREFERENCES,
  migrateDraft,
  migrateSession,
  validateDraft,
} from "../lib/workspace";
import { buildRequest, compileDraft } from ".";
import { changeRoute, routeFor } from "./catalog";

test("each family has its own contract and compatible provider routes", () => {
  const flux = newDraft(),
    gpt = newDraft(DEFAULT_PREFERENCES, "gpt"),
    qwen = newDraft(DEFAULT_PREFERENCES, "qwen");
  expect(gpt.params.resolution).toBeUndefined();
  expect(qwen.params.quality).toBeUndefined();
  expect(routeFor({ modelId: gpt.modelId, provider: "bfl" })).toBeUndefined();
  expect(routeFor({ modelId: flux.modelId, provider: "comfy" })?.maxRefs).toBe(
    10,
  );
  expect(
    routeFor({ modelId: qwen.modelId, provider: "runware" })?.maxRefs,
  ).toBe(3);
  expect(
    routeFor({ modelId: qwen.modelId, provider: "openrouter" })?.maxRefs,
  ).toBe(4);
});
test("plain models send plain text without FLUX JSON and omit unavailable parameters", () => {
  const gpt = {
    ...newDraft(DEFAULT_PREFERENCES, "gpt"),
    prompt: "Edit this image",
  };
  const req = buildRequest(gpt, []);
  expect(req.model).toBe("gpt-image-2.5-flare");
  expect(req.finalPrompt).toBe("Edit this image");
  expect(req.regions).toEqual([]);
  expect(req.params.size).toBeUndefined();
  expect(req.params.resolution).toBeUndefined();
  const qwen = {
    ...newDraft(DEFAULT_PREFERENCES, "qwen"),
    prompt: "A poster with text",
  };
  const q = buildRequest(qwen, []);
  expect(q.params.promptExtend).toBeUndefined();
  expect(q.params.negativePrompt).toBeUndefined();
  expect(q.params.count).toBe(1);
  expect(compileDraft(qwen).rows).toEqual([]);
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
  expect(req.instruction).toBe("Move <star>");
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
test("v2 FLUX drafts migrate and future versions never overwrite local data", () => {
  const { family: _, modelId: __, mask: ___, ...old } = newDraft();
  const migrated = migrateDraft({ ...old, schema: 2, prompt: "older work" });
  expect(migrated.family).toBe("flux");
  expect(migrated.schema).toBe(3);
  expect(migrated.prompt).toBe("older work");
  const session = migrateSession({
    schema: 1,
    activeFamily: "gpt",
    workspaces: { flux: migrated, gpt: newDraft(DEFAULT_PREFERENCES, "gpt") },
  });
  expect(session?.workspaces.flux?.prompt).toBe("older work");
  expect(() => migrateSession({ ...old, schema: 999 })).toThrow();
});
