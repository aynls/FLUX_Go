import { useState } from "react";
import Canvas from "../../components/Canvas";
import { routeFor } from "../../models/catalog";
import { outputEstimate } from "../../lib/workspace";
import type { StageProps } from "../shared/Stage";
export default function GptStage(p: StageProps) {
  const d = p.draft,
    first = d.refs[0] ?? null;
  const [tool, setTool] = useState<"pan" | "brush" | "eraser" | "mask-box">(
    "pan",
  );
  const [radius, setRadius] = useState(32);
  const supported = routeFor(d)?.mask;
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
            <button
              disabled={!d.mask}
              onClick={() => p.onChange({ ...d, mask: null, maskRects: [] })}
            >
              移除蒙版
            </button>
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
        <div className="mask-summary">
          {d.mask && <img src={d.mask.dataUrl} alt="编辑蒙版" />}
          <p className="help">
            {supported
              ? "黑色区域用于编辑。画笔添加编辑区，橡皮恢复保留区；半径按原图像素计算，空格或中键拖动画面。也可导入带透明区域的 PNG。"
              : "此路由支持参考图编辑；使用蒙版时请切换 Comfy 或 Runware。"}
          </p>
        </div>
      </div>
      {p.references}
    </div>
  );
}
