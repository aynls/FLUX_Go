import { describe, expect, test } from "bun:test";
import { fitView, imgToScreen, screenToImg, type View } from "./coords";

const EPS = 1e-9;

function roundtrip(v: View, x: number, y: number) {
  const s = imgToScreen(v, x, y);
  const back = screenToImg(v, s.x, s.y);
  expect(Math.abs(back.x - x)).toBeLessThan(EPS);
  expect(Math.abs(back.y - y)).toBeLessThan(EPS);
}

describe("视图变换", () => {
  test("screen 与图像坐标可以往返", () => {
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
