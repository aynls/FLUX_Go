import { describe, expect, test } from "bun:test";
import { composePrompt, rectToWire } from "./protocol";
import type { Box } from "./types";

describe("rectToWire（0–1000，顺序 [y0, x0, y1, x1]）", () => {
  test("坐标顺序是 [y0, x0, y1, x1] 而非 [x0, y0, ...]", () => {
    // 一个“高瘦”框：x 400-500, y 100-800
    const wire = rectToWire({ x: 400, y: 100, w: 100, h: 700 }, 1000, 1000);
    expect(wire).toEqual([100, 400, 800, 500]);
    // wire[2]-wire[0] 是纵向跨度（700），wire[3]-wire[1] 是横向跨度（100）
    expect(wire[2] - wire[0]).toBeGreaterThan(wire[3] - wire[1]);
  });
});

describe("composePrompt", () => {
  const box = (over: Partial<Box>): Box => ({
    id: "obj_1",
    role: "new",
    rect: { x: 640, y: 64, w: 200, h: 200 },
    desc: "a yellow star",
    ...over,
  });

  test("编辑模式 new 角色：from/src 为 null，JSON 追加在指令后", () => {
    const r = composePrompt({
      mode: "edit",
      instruction: "add a star",
      boxes: [box({})],
      iw: 1000,
      ih: 1000,
    });
    expect(r.error).toBeNull();
    expect(r.finalPrompt).toBe(
      'add a star [{"id":"obj_1","from":null,"src_bbox":null,"tgt_bbox":[64,640,264,840],"desc":"a yellow star"}]',
    );
  });

  test("编辑模式 anchor：src=tgt、from=ref_image_0", () => {
    const r = composePrompt({
      mode: "edit",
      instruction: "keep this",
      boxes: [box({ role: "anchor", desc: "the apple" })],
      iw: 1000,
      ih: 1000,
    });
    const row = JSON.parse(r.finalPrompt.slice("keep this ".length))[0];
    expect(row.from).toBe("ref_image_0");
    expect(row.src_bbox).toEqual(row.tgt_bbox);
    expect(row.desc).toBe("the apple");
  });

  test("文生图放置协议 {id, bbox, desc}", () => {
    const r = composePrompt({
      mode: "t2i",
      instruction: "a meadow",
      boxes: [box({ role: "place", rect: { x: 0, y: 0, w: 500, h: 500 } })],
      iw: 1024,
      ih: 1024,
    });
    expect(r.error).toBeNull();
    const row = JSON.parse(r.finalPrompt.slice("a meadow ".length))[0];
    expect(Object.keys(row)).toEqual(["id", "bbox", "desc"]);
    expect(row.bbox).toEqual([0, 0, 488, 488]); // 500/1024*1000 = 488.28 → 488
  });

  test("校验：ID 非法 / 重复 / 缺描述 / move 缺源", () => {
    const base = {
      iw: 1000,
      ih: 1000,
      mode: "edit" as const,
      instruction: "x",
    };
    expect(
      composePrompt({ ...base, boxes: [box({ id: "bad id!" })] }).error,
    ).toContain("ID");
    expect(
      composePrompt({
        ...base,
        boxes: [
          box({}),
          box({ id: "obj_1", rect: { x: 0, y: 0, w: 50, h: 50 } }),
        ],
      }).error,
    ).toContain("重复");
    expect(
      composePrompt({ ...base, boxes: [box({ desc: "" })] }).error,
    ).toContain("区域描述");
    expect(
      composePrompt({ ...base, boxes: [box({ role: "move" })] }).error,
    ).toContain("源区域");
  });
});
