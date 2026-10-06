import { expect, test } from "bun:test";
import {
  newDraft,
  DEFAULT_PREFERENCES,
  migrateDraft,
  migrateSession,
  validateDraft,
} from "../lib/workspace";
import { buildRequest, compileDraft } from ".";
import { changeRoute } from "./catalog";
import { setPrimaryImage } from "../lib/workspace";
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
  const edit = { ...newDraft(), intent: "edit" as const, prompt: "edit work" };
  const tasks = migrateSession({
    schema: 1,
    activeFamily: "flux",
    workspaces: { flux: migrated },
    taskWorkspaces: { "flux:create": migrated, "flux:edit": edit },
  });
  expect(tasks?.taskWorkspaces?.["flux:create"]?.prompt).toBe("older work");
  expect(tasks?.taskWorkspaces?.["flux:edit"]?.prompt).toBe("edit work");
  expect(() =>
    migrateSession({
      schema: 1,
      activeFamily: "flux",
      workspaces: { flux: migrated },
      taskWorkspaces: { "flux:create": edit },
    }),
  ).toThrow("工作区任务不匹配");
  expect(() => migrateSession({ ...old, schema: 999 })).toThrow();
});
test("legacy overlay selection does not rewrite the actual API order or original prompt", () => {
  const old = {
    ...newDraft(),
    prompt: "Edit <ref_image_0> using <ref_image_1>",
    baseId: "preview",
    refs: [
      {
        uid: "actual-first",
        name: "first",
        dataUrl: "a",
        width: 1024,
        height: 1024,
      },
      {
        uid: "preview",
        name: "preview",
        dataUrl: "b",
        width: 1024,
        height: 1024,
      },
    ],
  };
  delete old.intent;
  const migrated = migrateDraft(JSON.parse(JSON.stringify(old)));
  expect(migrated.baseId).toBe("actual-first");
  expect(
    buildRequest(
      migrated,
      migrated.refs.map((r) => r.dataUrl),
    ).images,
  ).toEqual(["a", "b"]);
  expect(compileDraft(migrated).finalPrompt).toBe(old.prompt);
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
  expect(migrateDraft(JSON.parse(JSON.stringify(other))).routeSettings).toEqual(
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
