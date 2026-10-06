import { describe, expect, test } from "bun:test";
import {
  fitView,
  fitMinimumScale,
  imgToScreen,
  screenToImg,
  clampCanvasView,
  MIN_SCALE,
  MAX_SCALE,
  PAN_RANGE_MULTIPLIER,
  MIN_VISIBLE_CANVAS_PX,
  zoomCanvasAt,
  type View,
} from "./coords";

const EPS = 1e-9;

test("high resolution previews fit the entire image while FLUX keeps its original scale bounds", () => {
  const dims = [3840, 2160, 720, 420] as const;
  const minimum = fitMinimumScale(...dims);
  const fitted = fitView(...dims, 24, minimum);
  expect(fitted.scale).toBeLessThan(MIN_SCALE);
  expect(3840 * fitted.scale).toBeLessThanOrEqual(720 - 48);
  expect(2160 * fitted.scale).toBeLessThanOrEqual(420 - 48);
  expect(fitView(...dims).scale).toBe(MIN_SCALE);
  const bounded = zoomCanvasAt(fitted, 360, 210, 0.001, ...dims, minimum);
  expect(bounded.scale).toBe(minimum);
  expect(screenToImg(bounded, 360, 210)).toEqual(screenToImg(fitted, 360, 210));
});

test("pan follows configured range and retains visible canvas at every zoom", () => {
  for (const [iw, ih, vw, vh] of [
    [1024, 1024, 1100, 600],
    [512, 768, 900, 400],
    [4000, 200, 300, 600],
  ]) {
    for (const scale of [MIN_SCALE, 1, MAX_SCALE])
      for (const sign of [-1, 1]) {
        const v = clampCanvasView(
          { scale, tx: sign * 1e8, ty: sign * 1e8 },
          iw,
          ih,
          vw,
          vh,
        );
        for (const [offset, span, viewport] of [
          [v.tx, iw * v.scale, vw],
          [v.ty, ih * v.scale, vh],
        ]) {
          expect(Math.abs(offset - (viewport - span) / 2)).toBeLessThanOrEqual(
            Math.max(0, span - viewport) / 2 +
              (span * Math.max(0, PAN_RANGE_MULTIPLIER - 1)) / 2 +
              EPS,
          );
          expect(
            Math.min(viewport, offset + span) - Math.max(0, offset),
          ).toBeGreaterThanOrEqual(
            Math.min(MIN_VISIBLE_CANVAS_PX, viewport / 4, span) - EPS,
          );
        }
        expect(clampCanvasView(v, iw, ih, vw, vh)).toEqual(v);
      }
  }
});

test("zoom then pan can bring all four canvas edges into the viewport", () => {
  const cases: [number, number, number, number][] = [
    [1024, 1024, 1000, 600],
    [4000, 200, 300, 600],
    [200, 4000, 600, 300],
  ];
  for (const dims of cases) {
    const [iw, ih, vw, vh] = dims;
    let v = fitView(...dims);
    v = zoomCanvasAt(v, vw / 2, vh / 2, MAX_SCALE / v.scale, ...dims);
    const near = clampCanvasView({ ...v, tx: 1e8, ty: 1e8 }, ...dims);
    const far = clampCanvasView({ ...v, tx: -1e8, ty: -1e8 }, ...dims);
    for (const [start, end, span, viewport] of [
      [near.tx, far.tx, iw * v.scale, vw],
      [near.ty, far.ty, ih * v.scale, vh],
    ]) {
      // 向右/下拖动可查看左/上边；向左/上拖动可查看右/下边。
      expect(start).toBeGreaterThanOrEqual(-EPS);
      expect(start).toBeLessThanOrEqual(viewport + EPS);
      expect(end + span).toBeGreaterThanOrEqual(-EPS);
      expect(end + span).toBeLessThanOrEqual(viewport + EPS);
    }
  }
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

function roundtrip(v: View, x: number, y: number) {
  const s = imgToScreen(v, x, y);
  const back = screenToImg(v, s.x, s.y);
  expect(Math.abs(back.x - x)).toBeLessThan(EPS);
  expect(Math.abs(back.y - y)).toBeLessThan(EPS);
}

describe("视图变换", () => {
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
});
