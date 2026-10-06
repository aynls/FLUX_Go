import { reorderRefs, resizeCanvas } from "../../lib/workspace";
import { routeFor } from "../../models/catalog";
import type { Draft } from "../../lib/types";

export interface ReferencesProps {
  draft: Draft;
  ready: boolean;
  importing: boolean;
  onChange: (d: Draft) => void;
  onPreview: (id: string) => void;
  onFiles: () => void;
  onPaste: () => void;
  onUrl: () => void;
  onNotice: (text: string) => void;
}
export default function References(p: ReferencesProps) {
  const d = p.draft,
    max = routeFor(d)?.maxRefs ?? 0;
  const base = d.refs.find((r) => r.uid === d.baseId);
  const disabled = !p.ready || p.importing || d.refs.length >= max;
  function reorder(from: number, to: number) {
    const refs = [...d.refs];
    [refs[from], refs[to]] = [refs[to], refs[from]];
    if (d.mask && refs[0]?.uid !== d.refs[0]?.uid) {
      p.onNotice("蒙版作用于第一张参考图。请先移除蒙版，再改变第一张图片。");
      return;
    }
    p.onChange(reorderRefs(d, refs));
  }
  return (
    <section className={"reference-strip references-" + d.family}>
      <div className="section-heading">
        <h2>
          参考素材 · {d.refs.length}/{max}
        </h2>
        <div className="row">
          <button disabled={disabled} onClick={p.onFiles}>
            添加文件
          </button>
          <button disabled={disabled} onClick={p.onPaste}>
            粘贴图片
          </button>
          <button disabled={disabled} onClick={p.onUrl}>
            图片 URL
          </button>
        </div>
      </div>
      {d.family !== "flux" && (
        <p className="help">
          {d.family === "gpt"
            ? "顺序决定编辑主图；蒙版始终作用于图片 1。"
            : "按图片顺序，在提示词中说明各图的用途。"}
        </p>
      )}
      <div className="references">
        {d.refs.length ? (
          d.refs.map((r, i) => (
            <div className="reference" key={r.uid}>
              <button
                className="reference-image"
                onClick={() => p.onPreview(r.uid!)}
              >
                <img src={r.dataUrl} alt={r.name} />
              </button>
              <div className="reference-meta">
                <strong title={r.name}>
                  {i + 1}. {r.name}
                </strong>
                <span>
                  {r.width}×{r.height}
                  {d.family === "flux" && r.uid === d.baseId
                    ? " · 编辑底图"
                    : d.family === "gpt" && i === 0
                      ? " · 编辑主图"
                      : ""}
                </span>
                <div className="row">
                  {d.family === "flux" && (
                    <button
                      title="设为编辑底图，不改变输出画布与参考图顺序"
                      onClick={() => p.onChange({ ...d, baseId: r.uid! })}
                    >
                      设为底图
                    </button>
                  )}
                  <button
                    disabled={i === 0}
                    title="向前排序"
                    onClick={() => reorder(i, i - 1)}
                  >
                    前移
                  </button>
                  <button
                    disabled={i === d.refs.length - 1}
                    title="向后排序"
                    onClick={() => reorder(i, i + 1)}
                  >
                    后移
                  </button>
                  <button
                    onClick={() => {
                      if (d.mask && i === 0) {
                        p.onNotice("请先移除作用于这张图片的蒙版。");
                        return;
                      }
                      if (
                        d.boxes.some((b) => b.sourceId === r.uid) ||
                        d.prompt.includes(`<ref_image_${i}>`)
                      ) {
                        p.onNotice(
                          "这张图片被区域或提示词引用。请先修改引用再移除，避免改变方案含义。",
                        );
                        return;
                      }
                      p.onChange({
                        ...reorderRefs(
                          d,
                          d.refs.filter((x) => x.uid !== r.uid),
                        ),
                        baseId: d.baseId === r.uid ? null : d.baseId,
                      });
                    }}
                  >
                    移除
                  </button>
                </div>
              </div>
            </div>
          ))
        ) : (
          <p className="help">支持多选文件、批量拖入、剪贴板和图片 URL</p>
        )}
      </div>
      {d.family === "flux" && base && (
        <div className="row">
          <button
            onClick={() => {
              p.onChange({
                ...resizeCanvas(d, { w: base.width, h: base.height }),
                params: { ...d.params, aspectRatio: "auto" },
              });
              p.onNotice("画布采用底图比例；auto 仍可能被提示词要求的比例覆盖");
            }}
          >
            画布采用底图比例
          </button>
          <button onClick={() => p.onChange({ ...d, baseId: null })}>
            隐藏底图
          </button>
          <p className="help">
            底图按输出比例铺满，仅辅助定位；来源图始终保留原尺寸。
          </p>
        </div>
      )}
    </section>
  );
}
