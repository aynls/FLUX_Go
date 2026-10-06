import Canvas from "./Canvas";
import { getResultBase, type SavedResult } from "../app/generation";
import type { WorkingImage } from "../lib/types";
import { taskIntent } from "../lib/workspace";
import { modelByAnyId, providers } from "../models/catalog";

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
  return (
    <div className="result-actions">
      {(p.attempts?.length ?? 0) > 1 && (
        <div className="result-gallery" aria-label="本工作区的尝试">
          {p.attempts!.map((attempt, i) => (
            <button
              key={attempt.item.id}
              className={attempt.item.id === r.item.id ? "active" : ""}
              aria-label={"查看尝试 " + (i + 1)}
              onClick={() => p.onAttempt?.(attempt)}
            >
              <img src={attempt.image.dataUrl} alt={"尝试 " + (i + 1)} />
            </button>
          ))}
        </div>
      )}
      {r.out.images.length > 0 && (
        <div className="result-gallery" aria-label="本次生成结果">
          {r.out.images.map((im, i) => (
            <button
              className={i === r.selectedIndex ? "active" : ""}
              key={i}
              onClick={() => p.onSelect(i)}
              aria-label={"查看结果 " + (i + 1)}
            >
              <img src={im.dataUrl} alt={"结果 " + (i + 1)} />
            </button>
          ))}
        </div>
      )}
      <div className="result-heading">
        <strong>{modelByAnyId(r.out.model)?.label ?? "最近生成"}</strong>
        <span className="result-save-state">
          {r.saved ? "已存历史" : "历史尚未保存"}
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
          <button onClick={() => p.onUse(r.image, false)}>添加为参考图</button>
        </div>
        <button className="primary" onClick={() => p.onUse(r.image, true)}>
          {taskIntent(r.snapshot) === "edit" ? "继续编辑" : "用这张图开始编辑"}
        </button>
        {!r.saved && (
          <button disabled={p.saving} onClick={p.onRetry}>
            重新保存历史
          </button>
        )}
      </div>
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
  );
}
