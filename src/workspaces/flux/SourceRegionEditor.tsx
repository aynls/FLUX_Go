import { useState } from "react";
import Canvas from "../../components/Canvas";
import Modal from "../../components/Modal";
import { RectFields } from "./RectFields";
import { scaleRect } from "../../lib/workspace";
import type { Box, Draft, Rect, WorkingImage } from "../../lib/types";

export default function SourceRegionEditor(p: {
  box: Box;
  image: WorkingImage;
  canvas: Draft["canvas"];
  onClose: () => void;
  onApply: (rect: Rect) => void;
}) {
  const [valid, setValid] = useState(true);
  const [rect, setRect] = useState(
    () =>
      p.box.srcRect ??
      scaleRect(p.box.rect, p.canvas, { w: p.image.width, h: p.image.height }),
  );
  return (
    <Modal title={`来源区域 · ${p.box.id}`} large onClose={p.onClose}>
      <div className="source-region-editor">
        <p>
          {p.image.name} · {p.image.width}×{p.image.height}
        </p>
        <div className="source-region-canvas">
          <Canvas
            image={p.image}
            phantom={{ w: p.image.width, h: p.image.height }}
            fitWholeImage
            boxes={[{ ...p.box, role: "modify", rect, srcRect: undefined }]}
            selectedId={p.box.id}
            tool="box"
            onSelect={() => {}}
            onChange={(boxes) => {
              if (boxes[0]) setRect(boxes[0].rect);
            }}
            onCreateRect={setRect}
          />
        </div>
        <p className="help">
          右键拖动重新画框，左键移动或调整边缘。此处只修改来源区域。
        </p>
        <RectFields
          label="来源区域 · 0–1000"
          rect={rect}
          width={p.image.width}
          height={p.image.height}
          onChange={setRect}
          onValidityChange={setValid}
        />
        <div className="row close-actions">
          <button onClick={p.onClose}>取消</button>
          <button
            className="primary"
            disabled={!valid}
            onClick={() => p.onApply(rect)}
          >
            应用来源区域
          </button>
        </div>
      </div>
    </Modal>
  );
}
