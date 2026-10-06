import Canvas from "../../components/Canvas";
import { scaleRect } from "../../lib/workspace";
import type { StageProps } from "../shared/Stage";
export default function FluxStage(p: StageProps) {
  const d = p.draft;
  const base = d.refs.find((r) => r.uid === d.baseId) ?? null;
  const boxes = d.boxes
    .filter((b) => b.role !== "remove")
    .map((b) => {
      const source = d.refs.find((r) => r.uid === b.sourceId);
      return {
        ...b,
        srcRect: undefined,
        rect:
          b.role === "anchor" && b.srcRect && source
            ? scaleRect(
                b.srcRect,
                { w: source.width, h: source.height },
                d.canvas,
              )
            : b.rect,
      };
    });
  return (
    <div className="flux-work-area">
      <div className="stage">
        <Canvas
          image={base}
          phantom={d.canvas}
          boxes={boxes}
          selectedId={p.selectedId}
          tool={p.tool}
          editMode={!!d.refs.length}
          onSelect={p.onSelect}
          onChange={p.onBoxesChange}
          onGestureStart={p.onGestureStart}
          onGestureEnd={p.onGestureEnd}
        />
      </div>
      {p.references}
    </div>
  );
}
