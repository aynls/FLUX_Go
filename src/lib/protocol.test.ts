import { expect, test } from "bun:test";
import { composePrompt } from "./protocol";
import type { Box } from "./types";

test("编辑模式把目标框按 [y0, x0, y1, x1] 追加到指令后", () => {
  const box: Box = {
    id: "obj_1",
    role: "new",
    rect: { x: 640, y: 64, w: 200, h: 200 },
    desc: "a yellow star",
  };
  const r = composePrompt({
    mode: "edit",
    instruction: "add a star",
    boxes: [box],
    iw: 1000,
    ih: 1000,
  });
  expect(r.error).toBeNull();
  expect(r.finalPrompt).toBe(
    'add a star [{"id":"obj_1","from":null,"src_bbox":null,"tgt_bbox":[64,640,264,840],"desc":"a yellow star"}]',
  );
});
