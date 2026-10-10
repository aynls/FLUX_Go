import { expect, test } from "bun:test";
import { newDraft, reorderRefs, setPrimaryImage } from "./workspace";
import type { Draft } from "./types";

function fixture(): Draft {
  return {
    ...newDraft(),
    provider: "bfl",
    canvas: { w: 1000, h: 500 },
    prompt: "Move <obj_1> from <ref_image_1> onto <ref_image_0>.",
    refs: [
      { uid: "a", dataUrl: "", width: 1000, height: 500, name: "base" },
      { uid: "b", dataUrl: "", width: 500, height: 1000, name: "source" },
    ],
    boxes: [
      {
        uid: "stable",
        id: "obj_1",
        role: "move",
        sourceId: "b",
        desc: "star",
        rect: { x: 500, y: 0, w: 500, h: 250 },
        srcRect: { x: 0, y: 500, w: 250, h: 500 },
      },
    ],
  };
}

test("重排参考图时同步改写标签，并保留来源身份", () => {
  const d = fixture();
  const next = reorderRefs(d, [d.refs[1], d.refs[0]]);
  expect(next.prompt).toBe(
    "Move <obj_1> from <ref_image_0> onto <ref_image_1>.",
  );
  expect(next.boxes[0].sourceId).toBe("b");
});

test("更换主图不会把已有蒙版挪到另一张图上", () => {
  const d = fixture();
  d.mask = { ...d.refs[0], name: "mask" };
  expect(() => setPrimaryImage(d, "b")).toThrow();
  expect(d.refs[0].uid).toBe("a");
});
