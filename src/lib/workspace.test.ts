import { expect, test } from "bun:test";
import {
  newDraft,
  resizeCanvas,
  reorderRefs,
  validateDraft,
  sourceOnCanvas,
  canvasToSource,
  setPrimaryImage,
  beginImageEdit,
} from "./workspace";
import { composePrompt } from "./protocol";
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
test("different source and target dimensions yield independent normalized coordinates", () => {
  const d = fixture();
  const c = composePrompt({
    mode: "edit",
    instruction: d.prompt,
    boxes: d.boxes,
    iw: d.canvas.w,
    ih: d.canvas.h,
    refs: d.refs,
  });
  expect(c.error).toBeNull();
  expect(c.rows[0]).toMatchObject({
    from: "ref_image_1",
    src_bbox: [500, 0, 1000, 500],
    tgt_bbox: [0, 500, 500, 1000],
  });
});
test("remove uses null target and the selected reference", () => {
  const d = fixture();
  d.boxes[0].role = "remove";
  const c = composePrompt({
    mode: "edit",
    instruction: d.prompt,
    boxes: d.boxes,
    iw: 1000,
    ih: 500,
    refs: d.refs,
  });
  expect(c.rows[0]).toMatchObject({
    from: "ref_image_1",
    src_bbox: [500, 0, 1000, 500],
    tgt_bbox: null,
  });
});
test("canvas resize preserves target framing and leaves source pixels unchanged", () => {
  const d = fixture();
  const next = resizeCanvas(d, { w: 2000, h: 1000 });
  expect(next.boxes[0].rect).toEqual({ x: 1000, y: 0, w: 1000, h: 500 });
  expect(next.boxes[0].srcRect).toEqual(d.boxes[0].srcRect);
  expect(d.canvas.w).toBe(1000);
});
test("reference reorder remaps tags simultaneously and retains source identity", () => {
  const d = fixture();
  const next = reorderRefs(d, [d.refs[1], d.refs[0]]);
  expect(next.prompt).toBe(
    "Move <obj_1> from <ref_image_0> onto <ref_image_1>.",
  );
  expect(next.boxes[0].sourceId).toBe("b");
  const c = composePrompt({
    mode: "edit",
    instruction: next.prompt,
    boxes: next.boxes,
    iw: 1000,
    ih: 500,
    refs: next.refs,
  });
  expect(c.rows[0]).toMatchObject({ from: "ref_image_0" });
});
test("compression catches valid original that becomes too narrow and supports correction", () => {
  const d = fixture();
  d.refs = [{ uid: "a", name: "wide", width: 4000, height: 300, dataUrl: "" }];
  d.maxInputEdge = 2048;
  d.prompt = "Use <ref_image_0>";
  d.boxes = [];
  expect(validateDraft(d).some((e) => e.includes("154"))).toBe(true);
  expect(validateDraft({ ...d, maxInputEdge: 4000 })).toEqual([]);
});
test("source geometry accounts for letterboxing and cannot leave the source bounds", () => {
  const ref = {
    uid: "source",
    name: "source",
    dataUrl: "",
    width: 1600,
    height: 800,
  };
  const canvas = { w: 1000, h: 1000 };
  const rect = { x: 400, y: 200, w: 800, h: 400 };
  expect(sourceOnCanvas(rect, ref, canvas)).toEqual({
    x: 250,
    y: 375,
    w: 500,
    h: 250,
  });
  expect(
    canvasToSource(sourceOnCanvas(rect, ref, canvas), ref, canvas),
  ).toEqual(rect);
  const outside = canvasToSource(
    { x: 2000, y: 2000, w: 500, h: 500 },
    ref,
    canvas,
  );
  expect(outside.x + outside.w).toBeLessThanOrEqual(ref.width);
  expect(outside.y + outside.h).toBeLessThanOrEqual(ref.height);
});
test("changing primary cannot silently move an existing mask to another image", () => {
  const d = fixture();
  d.mask = { ...d.refs[0], name: "mask" };
  expect(() => setPrimaryImage(d, "b")).toThrow("蒙版");
  expect(d.refs[0].uid).toBe("a");
});

test("new edit rounds clear image-bound geometry and deduplicate a retained reference used as main", () => {
  const d = fixture();
  d.intent = "edit";
  d.baseId = "a";
  d.mask = { ...d.refs[0], name: "mask" };
  d.maskRects = [{ x: 1, y: 1, w: 10, h: 10 }];
  const next = beginImageEdit(d, d.refs[1], true);
  expect(next.refs).toHaveLength(1);
  expect(next.refs[0].dataUrl).toBe(d.refs[1].dataUrl);
  expect(next.boxes).toEqual([]);
  expect(next.mask).toBeNull();
  expect(next.maskRects).toEqual([]);
  expect(next.prompt).toBe("");
  expect(d.boxes).toHaveLength(1);
  expect(d.mask).not.toBeNull();
});
