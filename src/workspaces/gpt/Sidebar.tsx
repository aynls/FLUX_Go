import {
  RouteControls,
  PromptEditor,
  ParameterFields,
  InputOptions,
  GenerateFooter,
  Validation,
  type WorkspaceControlsProps,
} from "../shared/Controls";
export default function GptSidebar(p: WorkspaceControlsProps) {
  return (
    <>
      <div className="sidebar-body">
        <RouteControls {...p} />
        <PromptEditor {...p} />
        <section>
          <h2>输出与质量</h2>
          <ParameterFields
            {...p}
            keys={[
              "quality",
              "size",
              "aspectRatio",
              "background",
              "outputFormat",
              "outputCompression",
            ]}
          />
        </section>
        <details>
          <summary>内容审核</summary>
          <ParameterFields {...p} keys={["moderation"]} />
        </details>
        <InputOptions {...p} />
        <Validation errors={p.errors} />
      </div>
      <GenerateFooter {...p} />
    </>
  );
}
