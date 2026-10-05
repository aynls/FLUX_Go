import { describe, expect, test } from "bun:test";
import {
  clampRectToImage,
  clampScale,
  fitView,
  handlePoint,
  hitTest,
  imgToScreen,
  moveRect,
  normalizeRect,
  pickHandle,
  rectFromDrag,
  resizeRect,
  screenToImg,
  zoomAt,
  clampCanvasView,
  MIN_SCALE,
  MAX_SCALE,
  PAN_RANGE_MULTIPLIER,
  MIN_VISIBLE_CANVAS_PX,
  zoomCanvasAt,
  type View,
} from "./coords";

const EPS = 1e-9;

test("pan follows configured range and retains visible canvas at every zoom", () => {
  for (const [iw, ih, vw, vh] of [[1024, 1024, 1100, 600], [512, 768, 900, 400], [4000, 200, 300, 600]]) {
    for (const scale of [MIN_SCALE, 1, MAX_SCALE]) for (const sign of [-1, 1]) {
      const v = clampCanvasView({ scale, tx: sign * 1e8, ty: sign * 1e8 }, iw, ih, vw, vh);
      for (const [offset, span, viewport] of [[v.tx, iw * v.scale, vw], [v.ty, ih * v.scale, vh]]) {
        expect(Math.abs(offset - (viewport - span) / 2)).toBeLessThanOrEqual(Math.max(0, span - viewport) / 2 + span * Math.max(0, PAN_RANGE_MULTIPLIER - 1) / 2 + EPS);
        expect(Math.min(viewport, offset + span) - Math.max(0, offset)).toBeGreaterThanOrEqual(Math.min(MIN_VISIBLE_CANVAS_PX, viewport / 4, span) - EPS);
      }
      expect(clampCanvasView(v, iw, ih, vw, vh)).toEqual(v);
    }
  }
});

test("zoom then pan can bring all four canvas edges into the viewport", () => {
  const cases: [number, number, number, number][] = [[1024, 1024, 1000, 600], [4000, 200, 300, 600], [200, 4000, 600, 300]];
  for (const dims of cases) {
    const [iw, ih, vw, vh] = dims;
    let v = fitView(...dims);
    v = zoomCanvasAt(v, vw / 2, vh / 2, MAX_SCALE / v.scale, ...dims);
    const near = clampCanvasView({ ...v, tx: 1e8, ty: 1e8 }, ...dims);
    const far = clampCanvasView({ ...v, tx: -1e8, ty: -1e8 }, ...dims);
    for (const [start, end, span, viewport] of [[near.tx, far.tx, iw * v.scale, vw], [near.ty, far.ty, ih * v.scale, vh]]) {
      // 向右/下拖动可查看左/上边；向左/上拖动可查看右/下边。
      expect(start).toBeGreaterThanOrEqual(-EPS);
      expect(start).toBeLessThanOrEqual(viewport + EPS);
      expect(end + span).toBeGreaterThanOrEqual(-EPS);
      expect(end + span).toBeLessThanOrEqual(viewport + EPS);
    }
  }
});

test("small canvas keeps its original centered pan allowance", () => {
  const dims = [400, 200, 1000, 600] as const;
  expect(clampCanvasView({ scale: 1, tx: -1e8, ty: -1e8 }, ...dims)).toEqual({ scale: 1, tx: 260, ty: 180 });
  expect(clampCanvasView({ scale: 1, tx: 1e8, ty: 1e8 }, ...dims)).toEqual({ scale: 1, tx: 340, ty: 220 });
});

test("repeated zoom clamps scale and does not drift when reaching limits", () => {
  const dims = [1024, 768, 1000, 600] as const;
  for (const factor of [0.01, 100]) {
    let v = fitView(...dims);
    for (let i = 0; i < 100; i++) v = zoomCanvasAt(v, 10, 590, factor, ...dims);
    expect(v.scale).toBe(factor < 1 ? MIN_SCALE : MAX_SCALE);
    expect(zoomCanvasAt(v, 10, 590, factor, ...dims)).toEqual(v);
  }
});

test("bounded zoom preserves pointer anchor when away from pan limits", () => {
  const v = fitView(1024, 768, 1000, 600);
  const next = zoomCanvasAt(v, 500, 300, 1.2, 1024, 768, 1000, 600);
  expect(screenToImg(next, 500, 300)).toEqual(screenToImg(v, 500, 300));
});

function roundtrip(v: View, x: number, y: number) {
  const s = imgToScreen(v, x, y);
  const back = screenToImg(v, s.x, s.y);
  expect(Math.abs(back.x - x)).toBeLessThan(EPS);
  expect(Math.abs(back.y - y)).toBeLessThan(EPS);
}

describe("视图变换", () => {
  test("fitView 横图在横视口", () => {
    const v = fitView(2000, 1000, 1000, 1000, 0);
    expect(v.scale).toBeCloseTo(0.5);
    expect(v.tx).toBeCloseTo(0);
    expect(v.ty).toBeCloseTo(250);
  });

  test("fitView 竖图居中并遵守缩放下限", () => {
    const v = fitView(500, 2000, 1000, 500, 0);
    expect(v.scale).toBe(MIN_SCALE);
    expect(v.tx).toBeCloseTo((1000 - 500 * MIN_SCALE) / 2);
    expect(v.ty).toBeCloseTo((500 - 2000 * MIN_SCALE) / 2);
  });

  test("fitView 边距生效", () => {
    const v = fitView(1000, 1000, 1000, 1000, 24);
    expect(v.scale).toBeCloseTo((1000 - 48) / 1000);
  });

  test("screen<->img 往返（多种视图）", () => {
    const views: View[] = [
      { scale: 1, tx: 0, ty: 0 },
      { scale: 0.25, tx: 130, ty: -40 },
      { scale: 8, tx: -2000, ty: 900 },
      fitView(1920, 1080, 800, 600),
    ];
    for (const v of views) {
      roundtrip(v, 0, 0);
      roundtrip(v, 555, 333);
      roundtrip(v, 1919.5, 1079.25);
    }
  });

  test("zoomAt 保持光标下的图像点不动", () => {
    const v0: View = { scale: 0.6, tx: 40, ty: -20 };
    const sx = 400;
    const sy = 300;
    const before = screenToImg(v0, sx, sy);
    const v1 = zoomAt(v0, sx, sy, 1.6);
    const after = screenToImg(v1, sx, sy);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    // 缩放比例正确
    expect(v1.scale).toBeCloseTo(v0.scale * 1.6);
  });

  test("zoomAt 缩小同样保持锚点", () => {
    const v0: View = { scale: 1, tx: 40, ty: -20 };
    const v1 = zoomAt(v0, 10, 10, 0.5);
    expect(v1.scale).toBeCloseTo(v0.scale * 0.5);
    const b = screenToImg(v0, 10, 10);
    const a = screenToImg(v1, 10, 10);
    expect(a.x).toBeCloseTo(b.x, 6);
  });

  test("缩放限制", () => {
    expect(clampScale(MIN_SCALE / 2)).toBe(MIN_SCALE);
    expect(clampScale(MAX_SCALE * 2)).toBe(MAX_SCALE);
    const v = zoomAt({ scale: MAX_SCALE, tx: 0, ty: 0 }, 0, 0, 4);
    expect(v.scale).toBe(MAX_SCALE);
  });

  test("zoomAt 不破坏视图往返", () => {
    const v1 = zoomAt({ scale: 2, tx: 100, ty: 100 }, 300, 200, 2);
    roundtrip(v1, 123, 456);
  });
});

describe("矩形操作", () => {
  test("normalizeRect 反向拖拽", () => {
    expect(normalizeRect(100, 200, 40, 50)).toEqual({ x: 40, y: 50, w: 60, h: 150 });
  });

  test("clampRectToImage 越界裁剪", () => {
    expect(clampRectToImage({ x: -10, y: -10, w: 50, h: 50 }, 100, 100)).toEqual({
      x: 0, y: 0, w: 40, h: 40,
    });
    expect(clampRectToImage({ x: 90, y: 90, w: 50, h: 50 }, 100, 100)).toEqual({
      x: 90, y: 90, w: 10, h: 10,
    });
    expect(clampRectToImage({ x: 0, y: 0, w: 500, h: 500 }, 100, 100)).toEqual({
      x: 0, y: 0, w: 100, h: 100,
    });
  });

  test("rectFromDrag 完整链路", () => {
    expect(rectFromDrag(1000, 1000, 300, 300, 800, 600)).toEqual({
      x: 300, y: 300, w: 500, h: 300,
    });
  });

  test("resizeRect 角点拖拽", () => {
    const r = { x: 100, y: 100, w: 100, h: 100 };
    // se 手柄向右下拖 50
    expect(resizeRect(r, "se", 50, 50, 8, 1000, 1000)).toEqual({ x: 100, y: 100, w: 150, h: 150 });
    // nw 手柄向左上拖 30，锚点为右下
    expect(resizeRect(r, "nw", -30, -30, 8, 1000, 1000)).toEqual({ x: 70, y: 70, w: 130, h: 130 });
  });

  test("resizeRect 强制最小尺寸（拖过对边）", () => {
    const r = { x: 100, y: 100, w: 100, h: 100 };
    // se 向左上拖太多 → 保持最小 20
    const next = resizeRect(r, "se", -500, -500, 20, 1000, 1000);
    expect(next.w).toBe(20);
    expect(next.h).toBe(20);
    expect(next.x).toBe(100);
    expect(next.y).toBe(100);
  });

  test("resizeRect 越出图像边界时裁剪", () => {
    const r = { x: 950, y: 100, w: 40, h: 40 };
    const next = resizeRect(r, "e", 500, 0, 8, 1000, 1000);
    expect(next.x + next.w).toBe(1000);
    expect(next.w).toBe(50);
  });

  test("resizeRect 最小尺寸受图像尺寸约束", () => {
    const r = { x: 0, y: 0, w: 30, h: 100 };
    // 拖过最小尺寸 → 钳制到 8
    const next = resizeRect(r, "e", -28, 0, 8, 1000, 1000);
    expect(next.w).toBe(8);
    // 图像本身小于最小尺寸 → 允许收缩到图像宽度
    const tiny = resizeRect({ x: 0, y: 0, w: 4, h: 100 }, "e", -10, 0, 8, 5, 1000);
    expect(tiny.w).toBe(5);
  });

  test("handlePoint 位置正确", () => {
    const r = { x: 0, y: 0, w: 100, h: 50 };
    expect(handlePoint(r, "nw")).toEqual({ x: 0, y: 0 });
    expect(handlePoint(r, "e")).toEqual({ x: 100, y: 25 });
    expect(handlePoint(r, "s")).toEqual({ x: 50, y: 50 });
  });

  test("pickHandle 命中与容差", () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    expect(pickHandle(r, 100, 100, 1)).toBe("nw");
    expect(pickHandle(r, 103, 100, 1)).toBe("nw");
    expect(pickHandle(r, 110, 100, 1)).toBeNull();
    // 屏幕容差随 scale 换算：scale=10 时 7 屏幕px ≈ 0.7 图像px
    expect(pickHandle(r, 100.5, 100, 10)).toBe("nw");
    expect(pickHandle(r, 101.5, 100, 10)).toBeNull();
    // scale=1 时容差为 7 图像px，100.5 自然命中
    expect(pickHandle(r, 100.5, 100, 1)).toBe("nw");
    expect(pickHandle(r, 112, 100, 1)).toBeNull();
  });

  test("hitTest", () => {
    const r = { x: 10, y: 10, w: 20, h: 20 };
    expect(hitTest(r, 10, 10)).toBe(true);
    expect(hitTest(r, 30, 30)).toBe(true);
    expect(hitTest(r, 31, 30)).toBe(false);
  });

  test("moveRect 钳制在图像内", () => {
    expect(moveRect({ x: 0, y: 0, w: 50, h: 50 }, -30, -30, 100, 100)).toEqual({
      x: 0, y: 0, w: 50, h: 50,
    });
    expect(moveRect({ x: 0, y: 0, w: 50, h: 50 }, 100, 100, 100, 100)).toEqual({
      x: 50, y: 50, w: 50, h: 50,
    });
  });
});
