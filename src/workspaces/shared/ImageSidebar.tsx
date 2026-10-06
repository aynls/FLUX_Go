import {
  RouteControls,
  PromptEditor,
  ParameterFields,
  QwenSizeFields,
  InputOptions,
  GenerateFooter,
  Validation,
  type WorkspaceControlsProps,
} from "./Controls";
import { fieldsFor } from "../../models/catalog";

export default function ImageSidebar(p: WorkspaceControlsProps) {
  const fields = fieldsFor(p.draft);
  return (
    <>
      <div className="sidebar-body">
        <RouteControls {...p} />
        <PromptEditor {...p} />
        <section>
          <h2>画面尺寸</h2>
          {fields.width ? (
            <QwenSizeFields {...p} />
          ) : (
            <ParameterFields {...p} keys={["resolution", "aspectRatio"]} />
          )}
          {p.draft.family === "seedream" &&
            fields.width?.nullable &&
            p.draft.params.width == null && (
              <p className="help">在提示词中描述画面比例，或选择自定义尺寸。</p>
            )}
        </section>
        {fields.seed && (
          <section>
            <h2>生成控制</h2>
            <ParameterFields {...p} keys={["seed"]} />
          </section>
        )}
        {(fields.outputFormat || fields.watermark) && (
          <details>
            <summary>输出文件</summary>
            <ParameterFields
              {...p}
              keys={["outputFormat", "outputCompression", "watermark"]}
            />
          </details>
        )}
        {(fields.thinkingLevel || fields.searchMode) && (
          <details>
            <summary>思考与联网</summary>
            <ParameterFields
              {...p}
              keys={[
                "thinkingLevel",
                "searchMode",
                "includeThoughts",
                "responseText",
              ]}
            />
          </details>
        )}
        <InputOptions {...p} />
        <Validation errors={p.errors} />
      </div>
      <GenerateFooter {...p} />
    </>
  );
}
