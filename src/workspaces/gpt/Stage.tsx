import { useState } from "react";
import Canvas from "../../components/Canvas";
import MaskThumbnail from "./MaskThumbnail";
import { routeFor } from "../../models/catalog";
import { outputEstimate, primaryImage } from "../../lib/workspace";
import type { StageProps } from "../shared/Stage";
export default function GptStage(p: StageProps) {
  const d = p.draft,
    first = primaryImage(d);
  const [tool, setTool] = useState<"pan" | "brush" | "eraser" | "mask-box">(
    "pan",
  );
  const [radius, setRadius] = useState(32);
  const supported = routeFor(d)?.mask && d.intent !== "create";
  return (
    <div className="gpt-work-area">
      <div className="gpt-editor">
        <div className="model-stage-heading">
          <strong>{first ? "图片 1 · 编辑主图" : "生成画面"}</strong>
          <div className="row">
            {supported && (
              <>
                {(
                  [
                    ["pan", "平移"],
                    ["brush", "画笔"],
                    ["eraser", "橡皮"],
                    ["mask-box", "矩形"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    disabled={!first}
                    aria-pressed={tool === id}
                    className={tool === id ? "active" : ""}
                    onClick={() => setTool(id)}
                  >
                    {label}
                  </button>
                ))}
                <button disabled={!first} onClick={p.onImportMask}>
                  导入蒙版
                </button>
              </>
            )}
            {d.mask && (
              <button
                disabled={!d.mask}
                onClick={() => p.onChange({ ...d, mask: null, maskRects: [] })}
              >
                移除蒙版
              </button>
            )}
          </div>
        </div>
        {supported && (
          <div className="mask-tools">
            <label htmlFor="mask-radius">画笔 / 橡皮半径</label>
            <input
              id="mask-radius"
              type="range"
              min={1}
              max={256}
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
            />
            <input
              aria-label="半径（像素）"
              type="number"
              min={1}
              max={256}
              value={radius}
              onChange={(e) =>
                setRadius(
                  Math.max(1, Math.min(256, Number(e.target.value) || 1)),
                )
              }
            />
            <span className="muted">px</span>
          </div>
        )}
        <div className="stage">
          <Canvas
            image={first}
            phantom={first ? null : outputEstimate(d)}
            dimensionLabel={
              !first && d.params.size === "auto"
                ? "模型自动决定尺寸"
                : undefined
            }
            boxes={[]}
            selectedId={null}
            onSelect={() => {}}
            onChange={() => {}}
            tool={supported && first ? tool : "pan"}
            readOnly={!supported || !first}
            coordinateMode="pixels"
            fitWholeImage
            mask={d.mask}
            brushRadius={radius}
            onMaskChange={
              supported && first
                ? (mask) => p.onChange({ ...d, mask, maskRects: [] })
                : undefined
            }
            onGestureStart={p.onGestureStart}
            onGestureEnd={p.onGestureEnd}
          />
        </div>
        {first && supported && (
          <div className="mask-summary">
            {d.mask && <MaskThumbnail image={first} mask={d.mask} />}
            <span className="muted">
              {d.mask ? "黑色为编辑区域" : "使用画笔或矩形标记编辑区域"}
            </span>
          </div>
        )}
      </div>
      {p.references}
    </div>
  );
}
