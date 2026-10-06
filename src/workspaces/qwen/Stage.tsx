import Canvas from "../../components/Canvas";
import { outputEstimate } from "../../lib/workspace";
import type { StageProps } from "../shared/Stage";
export default function QwenStage(p: StageProps) {
  const d = p.draft;
  return (
    <div className="qwen-work-area">
      <div className="qwen-composer">
        <div className="model-stage-heading">
          <strong>{d.refs.length ? "参考图预览" : "输出尺寸预览"}</strong>
          <span className="muted">
            {d.refs.length
              ? "按图片顺序在左侧描述编辑与合成"
              : "在左侧描述画面与文字排版"}
          </span>
        </div>
        <div className="stage">
          <Canvas
            image={d.refs[0] ?? null}
            phantom={d.refs.length ? null : outputEstimate(d)}
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
