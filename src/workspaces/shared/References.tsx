import {
  ArrowUp,
  ArrowDown,
  Eye,
  Trash,
  Plus,
  DotsThree,
} from "@phosphor-icons/react";
import {
  primaryImage,
  reorderRefs,
  setPrimaryImage,
  taskIntent,
} from "../../lib/workspace";
import { routeFor } from "../../models/catalog";
import type { Draft, ReferencePurpose } from "../../lib/types";
import { useEffect, type MouseEvent, type KeyboardEvent } from "react";

export interface ReferencesProps {
  draft: Draft;
  ready: boolean;
  importing: boolean;
  onChange: (d: Draft, discrete?: boolean) => void;
  onPreview: (id: string) => void;
  onFiles: () => void;
  onPaste: () => void;
  onUrl: () => void;
  onNotice: (text: string) => void;
}
export default function References(p: ReferencesProps) {
  useEffect(() => {
    const closeOutside = (e: PointerEvent) =>
      document
        .querySelectorAll<HTMLDetailsElement>(".action-menu[open]")
        .forEach((menu) => {
          if (!menu.contains(e.target as Node)) menu.open = false;
        });
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  const closeAction = (e: MouseEvent<HTMLDetailsElement>) => {
    if ((e.target as HTMLElement).closest?.("button"))
      e.currentTarget.open = false;
  };
  const closeKey = (e: KeyboardEvent<HTMLDetailsElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.open = false;
    }
  };
  const d = p.draft,
    max = routeFor(d)?.maxRefs ?? 0;
  const main = primaryImage(d),
    editing = taskIntent(d) === "edit";
  const disabled = !p.ready || p.importing || d.refs.length >= max;
  function makePrimary(uid: string) {
    try {
      p.onChange(setPrimaryImage(d, uid));
    } catch (e) {
      p.onNotice((e as Error).message);
    }
  }
  function reorder(from: number, to: number) {
    if (to < 0 || to >= d.refs.length) return;
    const refs = [...d.refs];
    [refs[from], refs[to]] = [refs[to], refs[from]];
    p.onChange(reorderRefs(d, refs));
  }
  return (
    <section className={"reference-strip references-" + d.family}>
      <div className="section-heading">
        <h2>
          素材{" "}
          <span className="muted">
            {d.refs.length}/{max}
          </span>
        </h2>
        <div className="reference-add">
          <button disabled={disabled} onClick={p.onFiles}>
            <Plus size={14} />
            添加文件
          </button>
          <details
            className="action-menu"
            onClick={closeAction}
            onKeyDown={closeKey}
          >
            <summary aria-label="更多导入方式">
              <DotsThree size={18} />
            </summary>
            <div className="menu-popover">
              <button disabled={disabled} onClick={p.onPaste}>
                粘贴图片
              </button>
              <button disabled={disabled} onClick={p.onUrl}>
                图片 URL
              </button>
            </div>
          </details>
        </div>
      </div>
      {!d.refs.length && (
        <div className="reference-empty">
          <strong>{editing ? "添加要编辑的主图" : "添加参考素材"}</strong>
          <span>拖入图片，或选择文件</span>
        </div>
      )}
      <div className="references">
        {d.refs.map((r, i) => {
          const isMain = main?.uid === r.uid;
          return (
            <article
              className={"reference" + (isMain ? " reference-primary" : "")}
              key={r.uid}
            >
              <div className="reference-card-heading">
                <span className={isMain ? "state-badge" : "muted"}>
                  {isMain ? "编辑主图" : "参考 " + (i + 1)}
                </span>
                <details
                  className="action-menu"
                  onClick={closeAction}
                  onKeyDown={closeKey}
                >
                  <summary aria-label={"素材操作 " + r.name}>
                    <DotsThree size={18} />
                  </summary>
                  <div className="menu-popover">
                    {!isMain && (
                      <button onClick={() => makePrimary(r.uid!)}>
                        设为编辑主图
                      </button>
                    )}
                    <button onClick={() => p.onPreview(r.uid!)}>
                      <Eye size={14} />
                      查看原图
                    </button>
                    <button
                      disabled={i === 0 || (editing && i === 1)}
                      onClick={() => reorder(i, i - 1)}
                    >
                      <ArrowUp size={14} />
                      前移
                    </button>
                    <button
                      disabled={isMain || i === d.refs.length - 1}
                      onClick={() => reorder(i, i + 1)}
                    >
                      <ArrowDown size={14} />
                      后移
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (d.mask && i === 0) {
                          p.onNotice("请先移除作用于主图的蒙版");
                          return;
                        }
                        if (
                          d.boxes.some((b) => b.sourceId === r.uid) ||
                          d.prompt.includes(`<ref_image_${i}>`)
                        ) {
                          p.onNotice("请先移除这张素材的区域或提示词引用");
                          return;
                        }
                        const next = reorderRefs(
                          d,
                          d.refs.filter((x) => x.uid !== r.uid),
                        );
                        p.onChange(
                          isMain
                            ? next.refs.length
                              ? setPrimaryImage(next, next.refs[0].uid!)
                              : { ...next, baseId: null }
                            : next,
                        );
                      }}
                    >
                      <Trash size={14} />
                      移除
                    </button>
                  </div>
                </details>
              </div>
              <button
                className="reference-image"
                onClick={() => p.onPreview(r.uid!)}
                aria-label={"预览 " + r.name}
              >
                <img src={r.dataUrl} alt={r.name} />
              </button>
              <div className="reference-meta">
                <strong title={r.name}>{r.name}</strong>
                <span>
                  {r.width}×{r.height}
                </span>
                {!isMain && (
                  <label>
                    用途
                    <select
                      aria-label={"素材用途 " + r.name}
                      value={r.purpose ?? "reference"}
                      onChange={(e) =>
                        p.onChange({
                          ...d,
                          intent: taskIntent(d),
                          refs: d.refs.map((x) =>
                            x.uid === r.uid
                              ? {
                                  ...x,
                                  purpose: e.target.value as ReferencePurpose,
                                }
                              : x,
                          ),
                        })
                      }
                    >
                      <option value="reference">综合参考</option>
                      <option value="style">风格参考</option>
                      <option value="subject">主体参考</option>
                      <option value="composition">构图参考</option>
                      <option value="custom">自定义用途</option>
                    </select>
                  </label>
                )}
                {!isMain && r.purpose === "custom" && (
                  <label>
                    用途说明
                    <textarea
                      rows={2}
                      value={r.note ?? ""}
                      maxLength={2000}
                      onChange={(e) =>
                        p.onChange(
                          {
                            ...d,
                            intent: taskIntent(d),
                            refs: d.refs.map((x) =>
                              x.uid === r.uid
                                ? { ...x, note: e.target.value }
                                : x,
                            ),
                          },
                          false,
                        )
                      }
                    />
                  </label>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {d.family === "flux" && main && (
        <label className="check reference-overlay-toggle">
          <input
            type="checkbox"
            checked={d.showBase !== false}
            onChange={(e) => p.onChange({ ...d, showBase: e.target.checked })}
          />
          在画布显示主图
        </label>
      )}
    </section>
  );
}
