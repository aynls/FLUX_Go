import { describe, expect, test } from "bun:test";
import { composePrompt, rectToWire, wireToRect } from "./protocol";
import type { Box } from "./types";

describe("rectToWire（0–1000，顺序 [y0, x0, y1, x1]）", () => {
  test("全图", () => {
    expect(rectToWire({ x: 0, y: 0, w: 1000, h: 500 }, 1000, 500)).toEqual([0, 0, 1000, 1000]);
  });

  test("已知区域", () => {
    // x 0-100, y 0-200，图 1000x1000 → y0=0,x0=0,y1=200,x1=100
    expect(rectToWire({ x: 0, y: 0, w: 100, h: 200 }, 1000, 1000)).toEqual([0, 0, 200, 100]);
  });

  test("四分位区域", () => {
    // 右上 1/4：x 500-1000, y 0-500
    expect(rectToWire({ x: 500, y: 0, w: 500, h: 500 }, 1000, 1000)).toEqual([0, 500, 500, 1000]);
  });

  test("坐标顺序是 [y0, x0, y1, x1] 而非 [x0, y0, ...]", () => {
    // 一个“高瘦”框：x 400-500, y 100-800
    const wire = rectToWire({ x: 400, y: 100, w: 100, h: 700 }, 1000, 1000);
    expect(wire).toEqual([100, 400, 800, 500]);
    // wire[2]-wire[0] 是纵向跨度（700），wire[3]-wire[1] 是横向跨度（100）
    expect(wire[2] - wire[0]).toBeGreaterThan(wire[3] - wire[1]);
  });

  test("非方形图像归一化", () => {
    // 图 1920x1080，框 x 960-1920, y 0-1080（右半）→ x0=500, x1=1000
    const wire = rectToWire({ x: 960, y: 0, w: 960, h: 1080 }, 1920, 1080);
    expect(wire).toEqual([0, 500, 1000, 1000]);
  });

  test("最小 1 单位", () => {
    const wire = rectToWire({ x: 100, y: 100, w: 0.5, h: 0.5 }, 1000, 1000);
    expect(wire[3]).toBeGreaterThan(wire[1]);
    expect(wire[2]).toBeGreaterThan(wire[0]);
  });

  test("wireToRect 往返（误差 ≤ 1 wire 单位）", () => {
    for (const [iw, ih] of [[1920, 1080], [1000, 1000], [640, 480]]) {
      const r = { x: iw * 0.2, y: ih * 0.3, w: iw * 0.25, h: ih * 0.4 };
      const wire = rectToWire(r, iw, ih);
      const back = wireToRect(wire, iw, ih);
      expect(Math.abs(back.x - r.x)).toBeLessThanOrEqual((iw / 1000) * 1.01);
      expect(Math.abs(back.y - r.y)).toBeLessThanOrEqual((ih / 1000) * 1.01);
      expect(Math.abs(back.w - r.w)).toBeLessThanOrEqual((iw / 1000) * 2.01);
      expect(Math.abs(back.h - r.h)).toBeLessThanOrEqual((ih / 1000) * 2.01);
    }
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

  test("无框：原样返回指令", () => {
    const r = composePrompt({ mode: "edit", instruction: "make it vivid", boxes: [], iw: 1000, ih: 1000 });
    expect(r.error).toBeNull();
    expect(r.finalPrompt).toBe("make it vivid");
  });

  test("编辑模式 new 角色：from/src 为 null，JSON 追加在指令后", () => {
    const r = composePrompt({ mode: "edit", instruction: "add a star", boxes: [box({})], iw: 1000, ih: 1000 });
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

  test("编辑模式 move：src 与 tgt 不同", () => {
    const r = composePrompt({
      mode: "edit",
      instruction: "move it",
      boxes: [box({
        role: "move",
        rect: { x: 0, y: 0, w: 100, h: 100 },
        srcRect: { x: 500, y: 500, w: 100, h: 100 },
      })],
      iw: 1000,
      ih: 1000,
    });
    const row = JSON.parse(r.finalPrompt.slice("move it ".length))[0];
    expect(row.src_bbox).toEqual([500, 500, 600, 600]);
    expect(row.tgt_bbox).toEqual([0, 0, 100, 100]);
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

  test("行顺序跟随框数组顺序（拖拽排序直接反映到协议）", () => {
    const a = box({ id: "a_1", rect: { x: 0, y: 0, w: 100, h: 100 } });
    const b = box({ id: "b_1", rect: { x: 200, y: 200, w: 100, h: 100 } });
    const r = composePrompt({ mode: "edit", instruction: "x", boxes: [b, a], iw: 1000, ih: 1000 });
    const rows = JSON.parse(r.finalPrompt.slice(2)) as { id: string }[];
    expect(rows.map((x) => x.id)).toEqual(["b_1", "a_1"]);
  });

  test("校验：ID 非法 / 重复 / 缺描述 / move 缺源", () => {
    const base = { iw: 1000, ih: 1000, mode: "edit" as const, instruction: "x" };
    expect(composePrompt({ ...base, boxes: [box({ id: "bad id!" })] }).error).toContain("ID");
    expect(
      composePrompt({ ...base, boxes: [box({}), box({ id: "obj_1", rect: { x: 0, y: 0, w: 50, h: 50 } })] }).error,
    ).toContain("重复");
    expect(composePrompt({ ...base, boxes: [box({ desc: "" })] }).error).toContain("区域描述");
    expect(composePrompt({ ...base, boxes: [box({ role: "move" })] }).error).toContain("源区域");
  });

  test("校验：空指令", () => {
    expect(composePrompt({ mode: "edit", instruction: "   ", boxes: [], iw: 1000, ih: 1000 }).error).toBe("请输入提示词");
  });

  test("指令首尾空白被裁剪", () => {
    const r = composePrompt({ mode: "edit", instruction: "  hello  ", boxes: [], iw: 100, ih: 100 });
    expect(r.finalPrompt).toBe("hello");
  });
});
