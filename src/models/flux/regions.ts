import type { Box, Draft } from "../../lib/types";
import { scaleRect } from "../../lib/workspace";
/** Merge canvas gestures without moving source-image coordinates or removal regions. */
export function updateFluxBoxes(d: Draft, boxes: Box[]): Draft {
  const merged = boxes.map((b) => {
    const prior = d.boxes.find((x) => x.uid === b.uid),
      ref = d.refs.find((r) => r.uid === prior?.sourceId);
    return prior
      ? {
          ...prior,
          rect: b.rect,
          ...(prior.role === "anchor" && ref
            ? {
                srcRect: scaleRect(b.rect, d.canvas, {
                  w: ref.width,
                  h: ref.height,
                }),
              }
            : {}),
        }
      : b;
  });
  const existing = d.boxes
    .map((b) => (b.role === "remove" ? b : merged.find((x) => x.uid === b.uid)))
    .filter((b): b is Box => !!b);
  return {
    ...d,
    boxes: [
      ...existing,
      ...merged.filter((b) => !d.boxes.some((x) => x.uid === b.uid)),
    ],
  };
}
