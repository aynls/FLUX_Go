import { displayValue } from "../../models/parameterLabels";
export { displayValue } from "../../models/parameterLabels";
import {
  defaultsFor,
  fieldsFor,
  pickParams,
  modelById,
  catalog,
  providers,
  changeRoute,
  routeFor,
  singleImageDraft,
  families,
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
  FamilyId,
} from "../../lib/types";
const FAMILY_ICONS: Record<FamilyId, string> = {
  flux: "/flux.png",
  gpt: "/openai.png",
  qwen: "/qwen-color.png",
  gemini: "/nano-banana.png",
  seedream: "/seeddream.png",
};

export interface WorkspaceControlsProps {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onFamilyChange?: (family: FamilyId) => void;
  providerStatus: ProviderStatus | null;
  busy: boolean;
  errors: string[];
  finalPreview: string;
  onSettings: () => void;
  onGenerate: (count: number) => void;
  generationTask?: GenerationTask | null;
  queueCount?: number;
  sentRequestId?: string;
  onShowTask?: () => void;
}
export function RouteControls({
  draft: d,
  onChange,
  providerStatus,
  onSettings,
  onFamilyChange,
  busy,
}: Pick<
  WorkspaceControlsProps,
  | "draft"
  | "onChange"
  | "providerStatus"
  | "onSettings"
  | "onFamilyChange"
  | "busy"
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
      {onFamilyChange && (
        <label>
          模型系列
          <div className="model-family-control">
            <img
              className={
                "family-icon" +
                (["flux", "gpt"].includes(d.family) ? " monochrome" : "")
              }
              src={FAMILY_ICONS[d.family]}
              alt=""
              aria-hidden="true"
            />
            <select
              aria-label="模型系列"
              value={d.family}
              disabled={busy}
              onChange={(e) => onFamilyChange(e.target.value as FamilyId)}
            >
              {families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        </label>
      )}
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
        <div className="route-warning">
          <p className="error-text">当前模型与供应商不支持蒙版。蒙版已保留。</p>
          <button onClick={() => onChange({ ...d, mask: null, maskRects: [] })}>
            移除蒙版
          </button>
        </div>
      )}
      {d.family !== "flux" && d.boxes.length > 0 && (
        <div className="route-warning">
          <p className={d.layoutEnabled === false ? "help" : "error-text"}>
            {d.layoutEnabled === false
              ? `保留 ${d.boxes.length} 个区域，当前不会发送。`
              : "此模型不支持区域。可暂停使用，切回 FLUX 后恢复。"}
          </p>
          {d.layoutEnabled !== false && (
            <button onClick={() => onChange({ ...d, layoutEnabled: false })}>
              暂不使用区域
            </button>
          )}
        </div>
      )}
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
            key !== "count" &&
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
  const customEdge =
    (routeFor(p.draft)?.minPixels ?? 0) > 1048576 ? 2048 : 1024;
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
                  width: e.target.value === "auto" ? null : customEdge,
                  height: e.target.value === "auto" ? null : customEdge,
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
          ...(p.draft.family === "seedream" && fields.width && !auto
            ? []
            : ["resolution"]),
          "aspectRatio",
          ...(auto ? [] : ["width", "height"]),
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
  const repeatCount = d.repeatCount ?? 1;
  const [sent, setSent] = useState(false);
  const [labelVisible, setLabelVisible] = useState(true);
  const lastFeedback = useRef(p.sentRequestId);
  const taskKey = `${d.family}:${taskIntent(d)}`;
  useEffect(() => {
    setSent(false);
    setLabelVisible(true);
    lastFeedback.current = p.sentRequestId;
  }, [taskKey]);
  useEffect(() => {
    if (!p.sentRequestId || p.sentRequestId === lastFeedback.current) return;
    lastFeedback.current = p.sentRequestId;
    setLabelVisible(false);
    const show = window.setTimeout(() => {
      setSent(true);
      setLabelVisible(true);
    }, 90);
    const fade = window.setTimeout(() => setLabelVisible(false), 1090);
    const restore = window.setTimeout(() => {
      setSent(false);
      setLabelVisible(true);
    }, 1180);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(fade);
      window.clearTimeout(restore);
    };
  }, [p.sentRequestId, taskKey]);
  const outputCount = repeatCount;
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
    saving: "保存到图库",
  };
  const job = p.generationTask;
  const perRequestCredits = estimateComfyCredits(singleImageDraft(d));
  const credits = perRequestCredits
    ? {
        min: perRequestCredits.min * repeatCount,
        max: perRequestCredits.max * repeatCount,
      }
    : null;
  const creditLabel = credits
    ? (formatCredits(credits.min) === formatCredits(credits.max)
        ? formatCredits(credits.min)
        : formatCredits(credits.min) + "–" + formatCredits(credits.max)) +
      " Credits"
    : null;
  const perRequestCost =
    d.family === "flux" && d.provider === "openrouter"
      ? estimateCost(d.params.resolution)
      : null;
  const cost = perRequestCost == null ? null : perRequestCost * repeatCount;
  const reason = p.busy
    ? ""
    : (p.errors.find((error) => error !== "请输入提示词") ??
      (!p.finalPreview
        ? ""
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
          {(job.intent ?? "create") !== taskIntent(d) && (
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
      <div className="generate-submit-row">
        <button
          className="primary wide"
          disabled={
            p.busy ||
            !p.providerStatus?.[d.provider] ||
            !!p.errors.length ||
            !p.finalPreview
          }
          onClick={() => p.onGenerate(repeatCount)}
          aria-describedby={reason ? "generation-reason" : undefined}
        >
          <span
            className="submit-label"
            style={{ opacity: labelVisible ? 1 : 0 }}
          >
            {sent
              ? "请求已发送"
              : `${taskIntent(d) === "edit" ? "应用编辑" : "生成图像"} · ${creditLabel ? "约 " + creditLabel : cost != null ? "约 $" + cost.toFixed(3) : outputCount + " 张"}`}
          </span>
        </button>
        <input
          className="generate-repeat-count"
          type="number"
          aria-label="生成张数"
          title="生成张数"
          min={1}
          max={20}
          step={1}
          value={repeatCount}
          disabled={p.busy}
          onChange={(e) => {
            const value = Number(e.target.value);
            p.onChange({
              ...d,
              repeatCount: Math.max(1, Math.min(20, Math.trunc(value) || 1)),
            });
          }}
        />
      </div>
      {!!p.queueCount && <p className="help">等待执行 {p.queueCount} 条</p>}
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
