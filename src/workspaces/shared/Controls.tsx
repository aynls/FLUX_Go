import {
  defaultsFor,
  fieldsFor,
  pickParams,
  modelById,
  catalog,
  providers,
  changeRoute,
  routeFor,
} from "../../models/catalog";
import { estimateCost } from "../../lib/params";
import { estimateComfyCredits, formatCredits } from "../../models/pricing";
import { sentSize, taskIntent } from "../../lib/workspace";
import { useEffect, useRef, useState } from "react";
import { gptSize } from "../../models/gpt";
import type {
  Draft,
  GenerateParams,
  ProviderId,
  ProviderStatus,
  GenerationTask,
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
  generationTask?: GenerationTask | null;
  onShowTask?: () => void;
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
  const switchRoute = (provider: ProviderId, modelId = d.modelId) => {
    onChange(changeRoute(d, provider, modelId));
  };
  return (
    <section>
      <div className="section-heading">
        <h2>模型与供应商</h2>
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
              switchRoute(provider, m.id);
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
          onChange={(e) => switchRoute(e.target.value as ProviderId)}
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
      {!!d.mask && !routeFor(d)?.mask && (
        <p className="error-text">当前供应商不支持蒙版</p>
      )}
    </section>
  );
}
const VALUE_LABELS: Record<string, string> = {
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
  opaque: "不透明",
  transparent: "透明",
  direct: "直接扩写",
  agent: "推理扩写",
  latest: "最新版本",
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP",
};
export function displayValue(key: string, value: GenerateParams[string]) {
  if (value == null) return key === "seed" ? "随机" : "供应商默认";
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  return VALUE_LABELS[String(value)] ?? String(value);
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
          if (field.kind === "enum" && field.values?.length === 1)
            return (
              <div className="fixed-field" key={key}>
                <span>{field.label}</span>
                <span>{displayValue(key, value ?? field.values[0])}</span>
                {value != null && !field.values.includes(String(value)) && (
                  <button onClick={() => change(key, field.values![0])}>
                    恢复默认
                  </button>
                )}
              </div>
            );
          if (key === "safetyTolerance")
            return (
              <label key={key}>
                {field.label}
                <select
                  aria-label={field.label}
                  value={value == null ? "default" : String(value)}
                  onChange={(e) =>
                    change(
                      key,
                      e.target.value === "default"
                        ? null
                        : Number(e.target.value),
                    )
                  }
                >
                  <option value="default">供应商默认</option>
                  {Array.from({ length: (field.max ?? 4) + 1 }, (_, n) => (
                    <option key={n} value={n}>
                      {n}
                      {n === 0
                        ? " · 最严格"
                        : n === field.max
                          ? " · 最宽松"
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
            );
          if (key === "seed")
            return (
              <div key={key} className="seed-field">
                <label>
                  随机种子
                  <select
                    aria-label="种子模式"
                    value={value == null ? "random" : "fixed"}
                    onChange={(e) =>
                      change(key, e.target.value === "random" ? null : 0)
                    }
                  >
                    <option value="random">随机</option>
                    <option value="fixed">固定种子</option>
                  </select>
                </label>
                {value != null && (
                  <div className="row">
                    <label className="grow">
                      种子值
                      <input
                        aria-label="种子值"
                        type="number"
                        min={field.min}
                        max={field.max}
                        value={Number(value)}
                        onChange={(e) =>
                          change(
                            key,
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                          )
                        }
                      />
                    </label>
                    <button
                      title="生成一个随机种子并固定"
                      onClick={() =>
                        change(
                          key,
                          crypto.getRandomValues(new Uint32Array(1))[0] %
                            2147483648,
                        )
                      }
                    >
                      换一个
                    </button>
                  </div>
                )}
              </div>
            );
          if (field.kind === "size")
            return (
              <SizeField
                key={key}
                value={String(value ?? "")}
                allowAuto={!!field.allowAuto}
                onChange={(v) => change(key, v)}
              />
            );
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
                  {value != null && !field.values?.includes(String(value)) && (
                    <option value={String(value)}>
                      {String(value)} · 不适用
                    </option>
                  )}
                  {field.values?.map((v) => (
                    <option
                      key={v}
                      value={v}
                      disabled={
                        (key === "promptExtendMode" &&
                          v === "agent" &&
                          d.refs.length > 0) ||
                        (key === "outputFormat" &&
                          v === "jpeg" &&
                          values.background === "transparent")
                      }
                    >
                      {key === "moderation" && v === "low"
                        ? "宽松"
                        : displayValue(key, v)}
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
              ) : (
                <textarea
                  rows={3}
                  value={String(value ?? "")}
                  maxLength={field.maxLength}
                  onChange={(e) => change(key, e.target.value)}
                />
              )}
            </label>
          );
        })}
    </div>
  );
}
export function SizeField({
  value,
  allowAuto,
  onChange,
}: {
  value: string;
  allowAuto: boolean;
  onChange: (value: string) => void;
}) {
  const size = gptSize(value);
  const parts = value.split(/[xX×*]/);
  return (
    <div className="size-field">
      {allowAuto && (
        <label>
          输出尺寸
          <select
            aria-label="尺寸模式"
            value={value === "auto" ? "auto" : "custom"}
            onChange={(e) =>
              onChange(e.target.value === "auto" ? "auto" : "1024x1024")
            }
          >
            <option value="auto">自动</option>
            <option value="custom">自定义</option>
          </select>
        </label>
      )}
      {value !== "auto" && (
        <>
          <div className="field-grid">
            <label>
              宽度（px）
              <input
                aria-label="输出宽度"
                type="number"
                min={16}
                max={3840}
                step={16}
                value={size?.w ?? parts[0] ?? ""}
                onChange={(e) =>
                  onChange(`${e.target.value}x${size?.h ?? parts[1] ?? 1024}`)
                }
              />
            </label>
            <label>
              高度（px）
              <input
                aria-label="输出高度"
                type="number"
                min={16}
                max={3840}
                step={16}
                value={size?.h ?? parts[1] ?? ""}
                onChange={(e) =>
                  onChange(`${size?.w ?? parts[0] ?? 1024}x${e.target.value}`)
                }
              />
            </label>
          </div>
          <div className="preset-row" aria-label="尺寸预设">
            {[
              ["方形", "1024x1024"],
              ["横向", "1536x1024"],
              ["竖向", "1024x1536"],
              ["2K", "2048x2048"],
            ].map(([label, v]) => (
              <button
                key={v}
                className={value === v ? "active" : ""}
                onClick={() => onChange(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
export function QwenSizeFields(
  p: Pick<WorkspaceControlsProps, "draft" | "onChange">,
) {
  const fields = fieldsFor(p.draft),
    auto = p.draft.params.width === null && p.draft.params.height === null;
  return (
    <>
      {fields.width?.nullable && (
        <label>
          尺寸模式
          <select
            aria-label="尺寸模式"
            value={auto ? "auto" : "custom"}
            onChange={(e) =>
              p.onChange({
                ...p.draft,
                params: {
                  ...p.draft.params,
                  width: e.target.value === "auto" ? null : 1024,
                  height: e.target.value === "auto" ? null : 1024,
                },
              })
            }
          >
            <option value="auto">模型自动推荐</option>
            <option value="custom">自定义</option>
          </select>
        </label>
      )}
      <ParameterFields
        {...p}
        keys={[
          "resolution",
          "aspectRatio",
          ...(auto ? [] : ["width", "height"]),
          "count",
        ]}
      />
    </>
  );
}
export function PromptEditor({
  draft: d,
  onChange,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (tag: string) => {
    const start = ref.current?.selectionStart ?? d.prompt.length,
      end = ref.current?.selectionEnd ?? start;
    const value =
      (start && !/\s$/.test(d.prompt.slice(0, start)) ? " " : "") + tag + " ";
    onChange({
      ...d,
      prompt: d.prompt.slice(0, start) + value + d.prompt.slice(end),
    });
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(
        start + value.length,
        start + value.length,
      );
    });
  };
  return (
    <section className="prompt-editor">
      <h2>{d.family === "gpt" && d.refs.length ? "编辑指令" : "提示词"}</h2>
      <textarea
        ref={ref}
        aria-label="提示词"
        rows={d.family === "qwen" ? 4 : 5}
        maxLength={32000}
        placeholder={
          d.family === "flux"
            ? "描述目标画面或修改内容…"
            : d.family === "qwen"
              ? "描述画面、版式和文字内容…"
              : "描述目标画面或修改内容…"
        }
        value={d.prompt}
        onChange={(e) => onChange({ ...d, prompt: e.target.value })}
      />
      {(d.refs.length > 0 || d.boxes.length > 0) && (
        <div className="tags">
          {d.refs.map((r, i) => (
            <button
              key={r.uid}
              title={r.name}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(`<ref_image_${i}>`)}
            >
              图片 {i + 1}
            </button>
          ))}
          {d.boxes.map((b) => (
            <button
              key={b.uid}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(`<${b.id}>`)}
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
      <summary>输入与请求</summary>
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
      <h3>实际发送参数</h3>
      <dl className="request-parameters">
        {Object.entries(
          pickParams(d.modelId, d.provider, {
            ...defaultsFor(d.modelId, d.provider),
            ...d.params,
          }),
        )
          .filter(
            ([key]) =>
              !(
                key === "outputCompression" && d.params.outputFormat === "png"
              ) &&
              !(key === "promptExtendMode" && d.params.promptExtend === false),
          )
          .map(([key, value]) => (
            <div key={key}>
              <dt>{catalog.fields[key]?.label ?? key}</dt>
              <dd>{displayValue(key, value)}</dd>
            </div>
          ))}
      </dl>
      <h3>生成指令</h3>
      <pre>{finalPreview || "（待输入）"}</pre>
    </details>
  );
}
export function GenerateFooter(p: WorkspaceControlsProps) {
  const d = p.draft;
  const outputCount = fieldsFor(d).count ? (d.params.count ?? 1) : 1;
  const [elapsed, setElapsed] = useState(0);
  const startedAt = p.generationTask?.startedAt;
  useEffect(() => {
    if (!startedAt) return;
    const update = () =>
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const labels = {
    preparing: "准备输入",
    submitting: "提交请求",
    queued: "排队中",
    reasoning: "理解指令",
    generating: "生成中",
    waiting: "等待结果",
    downloading: "下载结果",
    saving: "保存历史",
  };
  const job = p.generationTask;
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
  const reason = p.busy
    ? ""
    : (p.errors[0] ??
      (!p.finalPreview
        ? "填写提示词后生成"
        : !p.providerStatus?.[d.provider]
          ? "配置当前供应商的 API Key 后生成"
          : ""));
  return (
    <div className="generate-footer">
      {job && (
        <div className="generation-status" role="status">
          <div>
            <span className="activity-dot" aria-hidden="true" />
            {labels[job.phase]}
            <span className="muted" aria-hidden="true">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </span>
          </div>
          <span className="muted">
            {modelById(job.modelId)?.label} ·{" "}
            {providers.find((v) => v.id === job.provider)?.label}
            {job.completed != null && job.total > 1
              ? ` · ${job.completed}/${job.total} 张`
              : ""}
          </span>
          {(job.family !== d.family ||
            (job.intent ?? "create") !== taskIntent(d)) && (
            <button onClick={p.onShowTask}>返回任务工作区</button>
          )}
          {job.taskId && (
            <details>
              <summary>任务详情</summary>
              <code>{job.taskId}</code>
            </details>
          )}
        </div>
      )}
      <button
        className="primary wide"
        disabled={
          p.busy ||
          !p.providerStatus?.[d.provider] ||
          !!p.errors.length ||
          !p.finalPreview
        }
        onClick={p.onGenerate}
        aria-describedby={reason ? "generation-reason" : undefined}
      >
        {p.busy
          ? job
            ? "任务进行中…"
            : "准备中…"
          : `${taskIntent(d) === "edit" ? "应用编辑" : "生成图像"} · ${creditLabel ? "约 " + creditLabel : cost != null ? "约 $" + cost.toFixed(3) : outputCount + " 张"}`}
      </button>
      {reason && (
        <div id="generation-reason" className="generation-reason">
          <span>{reason}</span>
          {!p.providerStatus?.[d.provider] &&
            p.finalPreview &&
            !p.errors.length && <button onClick={p.onSettings}>配置</button>}
        </div>
      )}
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
