import { m } from "../../i18n";
import {
  RouteControls,
  PromptEditor,
  ParameterFields,
  InputOptions,
  GenerateFooter,
  Validation,
  FrameSizeFields,
  type WorkspaceControlsProps,
} from "../shared/Controls";
export default function QwenSidebar(p: WorkspaceControlsProps) {
  return (
    <>
      <div className="sidebar-body">
        <RouteControls {...p} />
        <PromptEditor {...p} />
        <section>
          <h2>{m.frame_size()}</h2>
          <FrameSizeFields {...p} />
        </section>
        <section>
          <h2>{m.generation_controls()}</h2>
          <ParameterFields
            {...p}
            keys={["seed", "promptExtend", "promptExtendMode", "watermark"]}
          />
        </section>
        {p.draft.provider !== "openrouter" && (
          <details>
            <summary>{m.negative_prompt()}</summary>
            <ParameterFields {...p} keys={["negativePrompt"]} />
          </details>
        )}
        {p.draft.provider === "runware" && (
          <details>
            <summary>{m.output_file()}</summary>
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
