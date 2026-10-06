import Canvas from "../../components/Canvas";
import { scaleRect, primaryImage, sourceOnCanvas } from "../../lib/workspace";
import { ROLE_LABELS } from "../../models/flux/roles";
import type { StageProps } from "../shared/Stage";
export default function FluxStage(p: StageProps) {
  const d = p.draft;
  const base = d.showBase === false ? null : primaryImage(d);
  const selected = d.boxes.find((b) => b.id === p.selectedId);
  const selectedSource = d.refs.find((r) => r.uid === selected?.sourceId);
  const boxes = d.boxes
    .filter((b) => b.role !== "remove" || b.sourceId === base?.uid)
    .map((b) => {
      const source = d.refs.find((r) => r.uid === b.sourceId);
      return {
        ...b,
        srcRect:
          b.role !== "remove" && source && source.uid === base?.uid && b.srcRect
            ? sourceOnCanvas(b.srcRect, source, d.canvas)
            : undefined,
        rect:
          b.role === "remove" && b.srcRect && source
            ? sourceOnCanvas(b.srcRect, source, d.canvas)
            : b.role === "anchor" && b.srcRect && source
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
      <div className="flux-editor">
        {selected && (
          <div className="region-context">
            <span className="state-badge">{ROLE_LABELS[selected.role]}</span>
            <strong>{selected.id}</strong>
            {selectedSource && selected.srcRect && (
              <>
                <img src={selectedSource.dataUrl} alt="来源参考图" />
                <span className="muted">{selectedSource.name}</span>
              </>
            )}
          </div>
        )}
        <div className="stage">
          <Canvas
            image={base}
            imageFit="contain"
            fitWholeImage
            phantom={d.canvas}
            boxes={boxes}
            selectedId={p.selectedId}
            tool="box"
            editMode={!!d.refs.length}
            onSelect={p.onSelect}
            onChange={p.onBoxesChange}
            onGestureStart={p.onGestureStart}
            onGestureEnd={p.onGestureEnd}
          />
        </div>
      </div>
      {p.references}
    </div>
  );
}
