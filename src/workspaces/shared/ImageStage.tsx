import { m } from "../../i18n";
import Canvas from "../../components/Canvas";
import { outputEstimate, primaryImage } from "../../lib/workspace";
import type { StageProps } from "./Stage";

export default function ImageStage(p: StageProps) {
  const d = p.draft;
  return (
    <div className="image-work-area">
      <div className="image-composer">
        <div className="model-stage-heading">
          <strong>
            {primaryImage(d)
              ? m.stage_main()
              : d.params.width === null
                ? m.stage_auto_size()
                : m.stage_output()}
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
