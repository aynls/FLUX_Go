import Canvas from "../../components/Canvas";
import { outputEstimate, primaryImage } from "../../lib/workspace";
import type { StageProps } from "../shared/Stage";
export default function QwenStage(p: StageProps) {
  const d = p.draft;
  return (
    <div className="qwen-work-area">
      <div className="qwen-composer">
        <div className="model-stage-heading">
          <strong>
            {primaryImage(d)
              ? "编辑主图"
              : d.params.width === null
                ? "自动尺寸"
                : "输出画面"}
          </strong>
        </div>
        <div className="stage">
          <Canvas
            image={primaryImage(d)}
            phantom={primaryImage(d) ? null : outputEstimate(d)}
            dimensionLabel={
              !primaryImage(d) && d.params.width === null
                ? "模型自动决定尺寸"
                : undefined
            }
            boxes={[]}
            selectedId={null}
            tool="pan"
            readOnly
            coordinateMode="pixels"
            fitWholeImage
            onSelect={() => {}}
            onChange={() => {}}
          />
        </div>
      </div>
      {p.references}
    </div>
  );
}
