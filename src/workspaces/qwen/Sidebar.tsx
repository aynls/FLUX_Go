import {
  RouteControls,
  PromptEditor,
  ParameterFields,
  InputOptions,
  GenerateFooter,
  Validation,
  QwenSizeFields,
  type WorkspaceControlsProps,
} from "../shared/Controls";
export default function QwenSidebar(p: WorkspaceControlsProps) {
  return (
    <>
      <div className="sidebar-body">
        <RouteControls {...p} />
        <PromptEditor {...p} />
        <section>
          <h2>画面尺寸</h2>
          <QwenSizeFields {...p} />
        </section>
        <section>
          <h2>生成控制</h2>
          <ParameterFields
            {...p}
            keys={["seed", "promptExtend", "promptExtendMode", "watermark"]}
          />
        </section>
        {p.draft.provider !== "openrouter" && (
          <details>
            <summary>负面提示词</summary>
            <ParameterFields {...p} keys={["negativePrompt"]} />
          </details>
        )}
        {p.draft.provider === "runware" && (
          <details>
            <summary>输出文件</summary>
            <ParameterFields
              {...p}
              keys={["outputFormat", "outputCompression"]}
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
