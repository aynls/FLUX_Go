import Canvas from "./Canvas";
import { getResultBase, type SavedResult } from "../app/generation";
import type { WorkingImage } from "../lib/types";

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
      {r.out.images.length > 1 && (
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
      <div>
        <strong>最近生成</strong>
        <span className="muted">
          {r.image.width}×{r.image.height} ·{" "}
          {r.out.provider === "comfy"
            ? r.out.usage?.credits != null
              ? "实际 " + r.out.usage.credits + " Credits"
              : "实际 Credits 未返回"
            : r.item.cost !== null
              ? "$" + r.item.cost.toFixed(4)
              : r.out.usage?.credits != null
                ? r.out.usage.credits + " Credits"
                : "费用未返回"}{" "}
          · {r.saved ? "已存历史" : "历史尚未保存"}
        </span>
      </div>
      <div className="row">
        <button onClick={p.onSave}>另存为</button>
        <button onClick={p.onCopy}>复制图片</button>
        <button onClick={() => p.onUse(r.image, false)}>添加为参考图</button>
        <button onClick={() => p.onUse(r.image, true)}>继续编辑这张</button>
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
