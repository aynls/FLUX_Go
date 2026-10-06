import {
  defaultsFor,
  fieldsFor,
  modelById,
  catalog,
  providers,
  changeRoute,
  routeFor,
} from "../../models/catalog";
import { estimateCost } from "../../lib/params";
import { estimateComfyCredits, formatCredits } from "../../models/pricing";
import { sentSize } from "../../lib/workspace";
import type {
  Draft,
  GenerateParams,
  ProviderId,
  ProviderStatus,
} from "../../lib/types";

export interface WorkspaceControlsProps {
  draft: Draft;
  onChange: (draft: Draft) => void;
  providerStatus: ProviderStatus | null;
  busy: boolean;
  errors: string[];
  finalPreview: string;
  onSettings: () => void;
  onGenerate: () => void;
}
export function RouteControls({
  draft: d,
  onChange,
  providerStatus,
  onSettings,
}: Pick<
  WorkspaceControlsProps,
  "draft" | "onChange" | "providerStatus" | "onSettings"
>) {
  const models = catalog.models.filter((m) => m.family === d.family);
  const selected = modelById(d.modelId)!;
  return (
    <section>
      <div className="section-heading">
        <h2>生成方案</h2>
        <span className="muted">
          {d.refs.length ? "参考图生成 / 编辑" : "文生图"}
        </span>
      </div>
      {models.length > 1 && (
        <label>
          模型版本
          <select
            value={d.modelId}
            onChange={(e) => {
              const m = modelById(e.target.value)!;
              const provider = m.routes[d.provider]
                ? d.provider
                : (Object.keys(m.routes)[0] as ProviderId);
              onChange(changeRoute(d, provider, m.id));
            }}
          >
            {models.map((m) => (
              <option value={m.id} key={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        提供商
        <select
          value={d.provider}
          onChange={(e) =>
            onChange(changeRoute(d, e.target.value as ProviderId))
          }
        >
          {providers
            .filter((p) => selected.routes[p.id])
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
        </select>
      </label>
      <div className="credential-hint">
        <span>
          {providerStatus?.[d.provider] ? "已配置" : "尚未配置 API Key"}
        </span>
        <button onClick={onSettings}>设置</button>
      </div>
      {routeFor(d)?.notes && <p className="help">{routeFor(d)?.notes}</p>}
    </section>
  );
}
export function ParameterFields({
  draft: d,
  onChange,
  keys,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  keys: string[];
}) {
  const fields = fieldsFor(d);
  const values = { ...defaultsFor(d.modelId, d.provider), ...d.params };
  const change = (key: string, value: GenerateParams[string]) =>
    onChange({ ...d, params: { ...d.params, [key]: value } });
  return (
    <div className="parameter-fields">
      {keys
        .filter(
          (key) =>
            fields[key] &&
            !(key === "outputCompression" && values.outputFormat === "png") &&
            !(key === "promptExtendMode" && values.promptExtend === false),
        )
        .map((key) => {
          const field = fields[key];
          const value = values[key];
          if (field.kind === "boolean")
            return (
              <label className="check" key={key}>
                <input
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => change(key, e.target.checked)}
                />
                {field.label}
              </label>
            );
          return (
            <label key={key}>
              {field.label}
              {field.kind === "enum" ? (
                <select
                  value={String(value ?? "")}
                  onChange={(e) => change(key, e.target.value)}
                >
                  {field.values?.map((v) => (
                    <option key={v} value={v}>
                      {v === "auto" ? "自动" : v}
                    </option>
                  ))}
                </select>
              ) : field.kind === "integer" ? (
                <input
                  type="number"
                  value={value == null ? "" : Number(value)}
                  min={field.min}
                  max={field.max}
                  step={1}
                  placeholder={field.nullable ? "使用默认 / 随机" : undefined}
                  onChange={(e) =>
                    change(
                      key,
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                />
              ) : field.kind === "size" ? (
                <>
                  <input
                    list={"gpt-sizes-" + d.provider}
                    value={String(value ?? "")}
                    placeholder="1024x1024"
                    onChange={(e) => change(key, e.target.value)}
                  />
                  <datalist id={"gpt-sizes-" + d.provider}>
                    {[
                      ...(field.allowAuto ? ["auto"] : []),
                      "1024x1024",
                      "1536x1024",
                      "1024x1536",
                      "2048x2048",
                      "3840x2160",
                    ].map((s) => (
                      <option value={s} key={s} />
                    ))}
                  </datalist>
                </>
              ) : (
                <textarea
                  rows={3}
                  value={String(value ?? "")}
                  maxLength={field.maxLength}
                  onChange={(e) => change(key, e.target.value)}
                />
              )}
              {field.help && (
                <span className="help field-help">{field.help}</span>
              )}
            </label>
          );
        })}
    </div>
  );
}
export function PromptEditor({
  draft: d,
  onChange,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
}) {
  return (
    <section className="prompt-editor">
      <h2>{d.family === "gpt" && d.refs.length ? "编辑指令" : "提示词"}</h2>
      <textarea
        aria-label="提示词"
        rows={d.family === "qwen" ? 4 : 5}
        maxLength={32000}
        placeholder={
          d.family === "flux"
            ? "描述画面或修改内容。可用下方标签引用图片和区域。"
            : d.family === "qwen"
              ? "描述画面、版式和文字内容。将要渲染的文字放在引号中；编辑时按图片顺序说明用途。"
              : "描述目标画面或要修改的内容；有蒙版时，说明透明区域应如何变化。"
        }
        value={d.prompt}
        onChange={(e) => onChange({ ...d, prompt: e.target.value })}
      />
      {d.family === "flux" && (
        <div className="tags">
          {d.refs.map((r, i) => (
            <button
              key={r.uid}
              title={r.name}
              onClick={() =>
                onChange({ ...d, prompt: d.prompt + ` <ref_image_${i}>` })
              }
            >
              图片 {i + 1}
            </button>
          ))}
          {d.boxes.map((b) => (
            <button
              key={b.uid}
              onClick={() =>
                onChange({ ...d, prompt: d.prompt + ` <${b.id}>` })
              }
            >
              {b.id}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
export function InputOptions({
  draft: d,
  onChange,
  finalPreview,
}: Pick<WorkspaceControlsProps, "draft" | "onChange" | "finalPreview">) {
  return (
    <details>
      <summary>发送检查</summary>
      <label className="check">
        <input
          type="checkbox"
          checked={d.compressEnabled}
          onChange={(e) =>
            onChange({ ...d, compressEnabled: e.target.checked })
          }
        />
        发送前等比缩小参考图
      </label>
      <label>
        长边上限（px）
        <input
          type="number"
          min={256}
          max={8192}
          disabled={!d.compressEnabled}
          value={d.maxInputEdge}
          onChange={(e) =>
            onChange({ ...d, maxInputEdge: Number(e.target.value) })
          }
        />
      </label>
      {d.refs.map((r, i) => {
        const s = sentSize(r, d.compressEnabled, d.maxInputEdge);
        return (
          <p className="help" key={r.uid}>
            图片 {i + 1}：{r.width}×{r.height} → 发送 {s.w}×{s.h}
          </p>
        );
      })}
      {d.mask && <p className="help">蒙版与第一张参考图同步缩放。</p>}
      <h3>最终提示词</h3>
      <pre>{finalPreview || "（待输入）"}</pre>
    </details>
  );
}
export function GenerateFooter(p: WorkspaceControlsProps) {
  const d = p.draft;
  const credits = estimateComfyCredits(d);
  const creditLabel = credits
    ? (formatCredits(credits.min) === formatCredits(credits.max)
        ? formatCredits(credits.min)
        : formatCredits(credits.min) + "–" + formatCredits(credits.max)) +
      " Credits"
    : null;
  const cost =
    d.family === "flux" && d.provider === "openrouter"
      ? estimateCost(d.params.resolution)
      : null;
  return (
    <div className="generate-footer">
      <button
        className="primary wide"
        disabled={
          p.busy ||
          !p.providerStatus?.[d.provider] ||
          !!p.errors.length ||
          !p.finalPreview
        }
        onClick={p.onGenerate}
      >
        {p.busy
          ? "生成任务进行中…"
          : `生成 · ${creditLabel ? "约 " + creditLabel : cost != null ? "约 $" + cost.toFixed(3) : (d.params.count ?? 1) + " 张"}`}
      </button>
    </div>
  );
}
export function Validation({ errors }: { errors: string[] }) {
  return (
    !!errors.length && (
      <div className="validation" role="alert">
        {errors.map((e, i) => (
          <p key={i}>{e}</p>
        ))}
      </div>
    )
  );
}
