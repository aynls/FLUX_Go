import type { SavedResult } from "../app/generation";
import { modelByAnyId } from "../models/catalog";

export default function GenerationGrid(p: {
  attempts: SavedResult[];
  selected: SavedResult | null;
  onSelect: (attempt: SavedResult, index: number) => void;
}) {
  return (
    <div className="generation-grid-scroll">
      {!p.attempts.length && (
        <div className="gallery-empty">
          <strong>描述你想生成的画面</strong>
          <p>候选图片会逐张显示在这里，选中后可以用任意编辑模型继续创作。</p>
        </div>
      )}
      {[...p.attempts].reverse().map((attempt) => (
        <section className="generation-batch" key={attempt.item.id}>
          <div className="generation-batch-heading">
            <strong>
              {modelByAnyId(attempt.out.model)?.label ?? attempt.out.model}
            </strong>
            <span>
              {attempt.out.images.length} 张
              {attempt.item.status === "running"
                ? " · 继续生成中"
                : attempt.item.status === "partial"
                  ? " · 部分完成"
                  : ""}
            </span>
          </div>
          <p title={attempt.snapshot.prompt}>{attempt.snapshot.prompt}</p>
          <div className="generation-grid">
            {attempt.out.images.map((im, index) => {
              const active =
                attempt.item.id === p.selected?.item.id &&
                index === p.selected.selectedIndex;
              return (
                <button
                  key={index}
                  className={active ? "active" : ""}
                  onClick={() => p.onSelect(attempt, index)}
                  aria-pressed={active}
                  aria-label={
                    attempt.item.id === p.selected?.item.id
                      ? `查看结果 ${index + 1}`
                      : `查看批次 ${new Date(attempt.item.createdAt).toLocaleTimeString()} 结果 ${index + 1}`
                  }
                >
                  <img
                    src={im.dataUrl}
                    alt={`候选图片 ${index + 1}`}
                    loading="lazy"
                  />
                  <span>{index + 1}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
