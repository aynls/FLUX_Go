import { m } from "../../i18n";
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
              ? m.qwen_main()
              : d.params.width === null
                ? m.qwen_auto_size()
                : m.qwen_output()}
          </strong>
        </div>
        <div className="stage">
          <Canvas
            image={primaryImage(d)}
            phantom={primaryImage(d) ? null : outputEstimate(d)}
            dimensionLabel={
              !primaryImage(d) && d.params.width === null
                ? m.model_picks_size()
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
    </div>
  );
}
