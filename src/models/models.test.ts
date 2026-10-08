import { expect, test } from "bun:test";
import { newDraft, DEFAULT_PREFERENCES, validateDraft } from "../lib/workspace";
import { buildRequest } from ".";
import { changeRoute } from "./catalog";

test("结构化区域在源图和目标画布上使用各自的坐标", () => {
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
  expect(buildRequest(d, ["x"]).regions).toEqual([
    {
      id: "star",
      description: "a star",
      referenceIndex: 0,
      sourceBox: [500, 500, 1000, 1000],
      targetBox: [0, 0, 500, 500],
    },
  ]);
});

test("切换路由会保留蒙版，并拒绝当前路由不支持的蒙版", () => {
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
});
