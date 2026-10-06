import Canvas from "./Canvas";
import GenerationInfo from "./GenerationInfo";
import { getResultBase, type SavedResult } from "../app/generation";
import type { WorkingImage } from "../lib/types";
import { taskIntent } from "../lib/workspace";
import { modelByAnyId, providers } from "../models/catalog";
import { useId, useState } from "react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";

export function ResultStage({
  result,
  view,
  original,
}: {
  result: SavedResult | null;
  view: "result" | "compare";
  original: boolean;
}) {
  if (!result) return <div className="stage" />;
  const base = getResultBase(result),
    image = result.image;
  return (
    <div className="stage">
      {original ? (
        <div className="original-view">
          {view === "compare" && base && (
            <img src={base.dataUrl} alt="原图原尺寸" />
          )}
          <img src={image.dataUrl} alt="生成结果原尺寸" />
        </div>
      ) : view === "compare" && base ? (
        <div className="comparison">
          <figure>
            <figcaption>原图 · 提交时快照</figcaption>
            <img src={base.dataUrl} alt="原图" />
          </figure>
          <figure>
            <figcaption>
              生成结果 · {image.width}×{image.height}
            </figcaption>
            <img src={image.dataUrl} alt="生成结果" />
          </figure>
        </div>
      ) : (
        <Canvas
          image={image}
          phantom={null}
          boxes={[]}
          selectedId={null}
          tool="pan"
          readOnly
          fitWholeImage
          onSelect={() => {}}
          onChange={() => {}}
        />
      )}
    </div>
  );
}
export function ResultActions(p: {
  compact?: boolean;
  result: SavedResult;
  attempts?: SavedResult[];
  onAttempt?: (result: SavedResult) => void;
  saving: boolean;
  onSelect: (i: number) => void;
  onSave: () => void;
  onCopy: () => void;
  onUse: (image: WorkingImage, edit: boolean) => void;
  onRetry: () => void;
}) {
  const r = p.result;
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const multipleAttempts = (p.attempts?.length ?? 0) > 1;
  return (
    <section
      className={"result-panel" + (p.compact ? " result-panel-compact" : "")}
      aria-label="生成记录"
    >
      {!p.compact && (
        <button
          className="result-panel-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          <strong>生成记录</strong>
          <span className="muted">
            {p.attempts?.length || 1} 个批次 · 当前 {r.out.images.length} 张
          </span>
          <span className="result-panel-toggle-label">
            {expanded ? "收起" : "展开"}
            {expanded ? <CaretDown size={16} /> : <CaretUp size={16} />}
          </span>
        </button>
      )}
      {(p.compact || expanded) && (
        <div className="result-actions" id={contentId}>
          {!p.compact && multipleAttempts && (
            <div className="result-gallery-group">
              <h3>最近批次</h3>
              <div className="result-gallery" aria-label="本工作区的尝试">
                {p.attempts!.map((attempt, i) => (
                  <button
                    key={attempt.item.id}
                    className={attempt.item.id === r.item.id ? "active" : ""}
                    aria-label={"查看尝试 " + (i + 1)}
                    aria-pressed={attempt.item.id === r.item.id}
                    title={
                      "批次 " +
                      (i + 1) +
                      " · " +
                      attempt.out.images.length +
                      " 张"
                    }
                    onClick={() => p.onAttempt?.(attempt)}
                  >
                    <img src={attempt.image.dataUrl} alt={"尝试 " + (i + 1)} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {!p.compact &&
            r.out.images.length > 0 &&
            (!multipleAttempts || r.out.images.length > 1) && (
              <div className="result-gallery-group">
                <h3>当前批次 · {r.out.images.length} 张</h3>
                <div className="result-gallery" aria-label="本次生成结果">
                  {r.out.images.map((im, i) => (
                    <button
                      className={i === r.selectedIndex ? "active" : ""}
                      key={i}
                      onClick={() => p.onSelect(i)}
                      aria-label={"查看结果 " + (i + 1)}
                      aria-pressed={i === r.selectedIndex}
                    >
                      <img src={im.dataUrl} alt={"结果 " + (i + 1)} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          <div className="result-heading">
            <strong>{modelByAnyId(r.out.model)?.label ?? "最近生成"}</strong>
            <span className="result-save-state">
              {r.saved ? "已存图库" : "图片尚未保存"}
            </span>
          </div>
          <div className="result-meta">
            <span>
              {providers.find((p) => p.id === r.out.provider)?.label ??
                r.out.provider}
            </span>
            <span>
              {r.image.width}×{r.image.height}
            </span>
            {r.out.provider === "comfy" ? (
              r.out.usage?.credits != null && (
                <span>{r.out.usage.credits} Credits</span>
              )
            ) : r.item.cost != null ? (
              <span>${r.item.cost.toFixed(4)}</span>
            ) : r.out.usage?.credits != null ? (
              <span>{r.out.usage.credits} Credits</span>
            ) : null}
          </div>
          <div className="result-operations">
            <div className="result-secondary">
              <button onClick={p.onSave}>另存为</button>
              <button onClick={p.onCopy}>复制图片</button>
              <button onClick={() => p.onUse(r.image, false)}>
                添加为参考图
              </button>
            </div>
            <button className="primary" onClick={() => p.onUse(r.image, true)}>
              {taskIntent(r.snapshot) === "edit"
                ? "继续编辑"
                : "用这张图开始编辑"}
            </button>
            {!r.saved && (
              <button disabled={p.saving} onClick={p.onRetry}>
                重新保存历史
              </button>
            )}
          </div>
          <GenerationInfo details={r.out.images[r.selectedIndex]?.details} />
          {r.out.notes.length > 0 && (
            <details>
              <summary>提供商说明</summary>
              {r.out.notes.map((n, i) => (
                <p className="help" key={i}>
                  {n}
                </p>
              ))}
            </details>
          )}
        </div>
      )}
    </section>
  );
}
