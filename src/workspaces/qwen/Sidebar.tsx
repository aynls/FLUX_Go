import {
  RouteControls,
  PromptEditor,
  ParameterFields,
  InputOptions,
  GenerateFooter,
  Validation,
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
          <ParameterFields
            {...p}
            keys={["resolution", "aspectRatio", "width", "height", "count"]}
          />
        </section>
        <section>
          <h2>生成控制</h2>
          <ParameterFields
            {...p}
            keys={["seed", "promptExtend", "promptExtendMode", "watermark"]}
          />
        </section>
        <section>
          <h2>避免出现的内容</h2>
          <ParameterFields {...p} keys={["negativePrompt"]} />
          {p.draft.provider === "openrouter" && (
            <p className="help">此路由暂不开放负面提示词和扩写参数。</p>
          )}
        </section>
        <InputOptions {...p} />
        <Validation errors={p.errors} />
      </div>
      <GenerateFooter {...p} />
    </>
  );
}
