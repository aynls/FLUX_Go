import { m } from "../../i18n";
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
          <h2>{m.frame_size()}</h2>
          {fields.width ? (
            <QwenSizeFields {...p} />
          ) : (
            <ParameterFields {...p} keys={["resolution", "aspectRatio"]} />
          )}
          {p.draft.family === "seedream" &&
            fields.width?.nullable &&
            p.draft.params.width == null && (
              <p className="help">{m.frame_ratio_help()}</p>
            )}
        </section>
        {(fields.seed || fields.quality) && (
          <section>
            <h2>{m.generation_controls()}</h2>
            <ParameterFields {...p} keys={["quality", "seed"]} />
          </section>
        )}
        {(fields.outputFormat || fields.watermark) && (
          <details>
            <summary>{m.output_file()}</summary>
            <ParameterFields
              {...p}
              keys={["outputFormat", "outputCompression", "watermark"]}
            />
          </details>
        )}
        {(fields.thinkingLevel || fields.searchMode) && (
          <details>
            <summary>{m.thinking_search()}</summary>
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
