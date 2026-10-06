import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Images,
  Plus,
  Clipboard,
  Trash,
  ArrowLeft,
  Eye,
} from "@phosphor-icons/react";
import { save } from "@tauri-apps/plugin-dialog";
import type { GalleryItem } from "../lib/types";
import * as api from "../lib/api";
import { modelByAnyId } from "../models/catalog";
import { exportDefaultPath } from "../lib/export";
import Modal from "./Modal";

export default function Gallery(p: {
  items: GalleryItem[];
  error: string;
  importing: boolean;
  saveDirectory: string;
  onRefresh: () => Promise<void>;
  onFiles: () => void;
  onPaste: () => void;
  onUse: (ids: string[]) => Promise<void>;
  onEdit: (item: GalleryItem) => Promise<void>;
  picker?: { limit: number; usedIds: string[] };
}) {
  const [filter, setFilter] = useState("all");
  const [selection, setSelection] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(!!p.picker);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [visibleCount, setVisibleCount] = useState(120);
  const [query, setQuery] = useState("");
  const used = new Set(p.picker?.usedIds ?? []);
  const limit = p.picker?.limit ?? Infinity;
  const filtered = useMemo(
    () =>
      p.items.filter(
        (item) =>
          (filter === "all" ||
            (filter === "generated"
              ? item.source === "generated"
              : item.source !== "generated")) &&
          [
            item.name,
            item.model && (modelByAnyId(item.model)?.label ?? item.model),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
      ),
    [p.items, filter, query],
  );
  const preview = p.items.find((item) => item.id === previewId);
  const groups = new Map<string, GalleryItem[]>();
  for (const item of filtered.slice(0, visibleCount)) {
    const date = new Date(item.createdAt).toLocaleDateString();
    groups.set(date, [...(groups.get(date) ?? []), item]);
  }
  useEffect(() => {
    setSelection((ids) =>
      ids.filter((id) => p.items.some((i) => i.id === id && !i.pendingDelete)),
    );
  }, [p.items]);
  useEffect(() => setVisibleCount(120), [query, filter]);
  const toggle = (id: string) => {
    setError("");
    setSelection((ids) =>
      ids.includes(id)
        ? ids.filter((v) => v !== id)
        : ids.length < limit
          ? [...ids, id]
          : ids,
    );
  };
  const run = async (action: () => Promise<void>) => {
    if (busy || p.importing) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const failed: string[] = [],
      messages: string[] = [];
    for (const id of deleteIds) {
      try {
        await api.galleryDelete(id);
      } catch (e) {
        failed.push(id);
        messages.push(String(e));
      }
    }
    await p.onRefresh();
    setSelection((ids) => ids.filter((id) => failed.includes(id)));
    if (
      previewId &&
      deleteIds.includes(previewId) &&
      !failed.includes(previewId)
    )
      setPreviewId(null);
    setDeleteIds(failed);
    if (messages.length) throw new Error(messages.join("；"));
  };
  const saveImage = async (item: GalleryItem) => {
    const ext = item.mime === "image/jpeg" ? "jpg" : item.mime.split("/")[1];
    const name = item.name
      .replace(/\.(png|jpe?g|webp|gif)$/i, "")
      .replace(/[<>:"/\\|?*]/g, "_");
    const path = await save({
      defaultPath: exportDefaultPath(p.saveDirectory, `${name}.${ext}`),
      filters: [{ name: "图片", extensions: [ext] }],
    });
    if (path)
      await api.saveDataUrl((await api.galleryRead(item.id)).dataUrl, path);
  };
  const locked = busy || p.importing;
  return (
    <div className={"gallery" + (p.picker ? " gallery-picker" : "")}>
      <div className="gallery-toolbar">
        <div className="gallery-title">
          <Images size={23} />
          <h2>{p.picker ? "选择参考素材" : "图库"}</h2>
          <span className="muted">{p.items.length} 张</span>
        </div>
        <div className="row">
          <button disabled={locked} onClick={p.onFiles}>
            <Plus size={16} />
            导入图片
          </button>
          <button disabled={locked} onClick={p.onPaste}>
            <Clipboard size={16} />
            粘贴
          </button>
          {!p.picker && (
            <button
              disabled={locked || !p.items.length}
              aria-pressed={selecting}
              onClick={() => {
                setSelecting(!selecting);
                setSelection([]);
                setError("");
              }}
            >
              {selecting ? "完成选择" : "选择"}
            </button>
          )}
        </div>
      </div>
      <div className="gallery-filters">
        <div className="segmented" aria-label="图片来源">
          {[
            ["all", "全部"],
            ["generated", "生成"],
            ["imported", "导入"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-label={"筛选" + label + "图片"}
              aria-pressed={filter === value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          aria-label="搜索图库"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称或模型"
        />
      </div>
      {p.picker && (
        <p className="gallery-hint">
          选择顺序即添加顺序 · 还可添加 {Math.max(0, limit - selection.length)}{" "}
          张
        </p>
      )}
      {(error || p.error) && (
        <div className="gallery-error" role="alert">
          {error || p.error}
          <button onClick={() => void run(p.onRefresh)}>刷新图库</button>
        </div>
      )}
      {p.importing && (
        <p className="gallery-hint" role="status">
          正在保存图片到图库…
        </p>
      )}
      <div className="gallery-scroll">
        {!filtered.length && (
          <div className="gallery-empty">
            <Images size={44} weight="thin" />
            <strong>
              {p.items.length ? "没有匹配的图片" : "把创作素材放在一起"}
            </strong>
            <p>
              {p.items.length
                ? "尝试其他名称、模型或来源。"
                : "导入本机图片或粘贴图片，生成结果也会自动保存在这里。"}
            </p>
          </div>
        )}
        {[...groups].map(([date, items]) => (
          <section className="gallery-day" key={date}>
            <h3>{date}</h3>
            <div className="gallery-grid">
              {items.map((item) => {
                const checked = selection.includes(item.id),
                  already = used.has(item.id);
                return (
                  <div className="gallery-cell" key={item.id}>
                    <button
                      className={"gallery-tile" + (checked ? " selected" : "")}
                      aria-label={
                        (selecting ? "选择图片 " : "查看图片 ") + item.name
                      }
                      aria-pressed={selecting ? checked : undefined}
                      disabled={
                        locked ||
                        (!!p.picker &&
                          (already ||
                            item.pendingDelete ||
                            (!checked && selection.length >= limit)))
                      }
                      title={item.name + " · " + item.width + "×" + item.height}
                      onClick={() => {
                        if (item.pendingDelete) {
                          setError("");
                          setDeleteIds([item.id]);
                        } else
                          selecting ? toggle(item.id) : setPreviewId(item.id);
                      }}
                    >
                      {!item.pendingDelete && (
                        <img
                          src={api.assetUrl(item.thumbPath)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                      )}
                      {item.pendingDelete ? (
                        <span className="gallery-tile-label">
                          删除未完成 · 重试
                        </span>
                      ) : already ? (
                        <span className="gallery-tile-label">已在当前任务</span>
                      ) : (
                        selecting && (
                          <span
                            className={
                              "gallery-check" + (checked ? " checked" : "")
                            }
                          >
                            {checked &&
                              (p.picker ? (
                                selection.indexOf(item.id) + 1
                              ) : (
                                <Check size={14} weight="bold" />
                              ))}
                          </span>
                        )
                      )}
                    </button>
                    {p.picker && !item.pendingDelete && (
                      <button
                        className="gallery-peek"
                        aria-label={"预览图片 " + item.name}
                        onClick={() => setPreviewId(item.id)}
                      >
                        <Eye size={16} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {filtered.length > visibleCount && (
          <button
            className="gallery-more"
            onClick={() => setVisibleCount((n) => n + 120)}
          >
            加载更多 · 还有 {filtered.length - visibleCount} 张
          </button>
        )}
      </div>
      {selecting && (
        <div
          className="gallery-selection"
          role="region"
          aria-label="图库选择操作"
        >
          <span>已选 {selection.length} 张</span>
          <button
            disabled={locked || !selection.length}
            onClick={() => setSelection([])}
          >
            清空选择
          </button>
          <button
            className="primary"
            disabled={locked || !selection.length}
            onClick={() => void run(() => p.onUse(selection))}
          >
            添加为参考素材{selection.length ? ` · ${selection.length} 张` : ""}
          </button>
          {!p.picker && (
            <button
              className="danger"
              disabled={locked || !selection.length}
              onClick={() => {
                setError("");
                setDeleteIds(selection);
              }}
            >
              <Trash size={16} />
              删除
            </button>
          )}
        </div>
      )}
      {preview && (
        <Modal
          title={preview.name}
          large
          onClose={() => {
            if (!busy) {
              setPreviewId(null);
              setError("");
            }
          }}
        >
          <div className="gallery-preview">
            <img src={api.assetUrl(preview.filePath)} alt={preview.name} />
          </div>
          <div className="gallery-detail-meta">
            <span>
              {preview.width}×{preview.height}
            </span>
            <span>
              {preview.model
                ? (modelByAnyId(preview.model)?.label ?? preview.model)
                : "导入图片"}
            </span>
            <span>{new Date(preview.createdAt).toLocaleString()}</span>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="gallery-detail-actions">
            <button
              disabled={locked}
              onClick={() => {
                setPreviewId(null);
                setError("");
              }}
            >
              <ArrowLeft size={16} />
              返回图库
            </button>
            {p.picker ? (
              <button
                className="primary"
                disabled={
                  locked ||
                  used.has(preview.id) ||
                  (!selection.includes(preview.id) && selection.length >= limit)
                }
                onClick={() => {
                  toggle(preview.id);
                  setPreviewId(null);
                }}
              >
                {selection.includes(preview.id) ? "取消选择" : "选择这张图片"}
              </button>
            ) : (
              <>
                <button
                  disabled={locked || preview.pendingDelete}
                  onClick={() =>
                    void run(async () => {
                      await p.onUse([preview.id]);
                      setPreviewId(null);
                    })
                  }
                >
                  添加为参考素材
                </button>
                <button
                  className="primary"
                  disabled={locked || preview.pendingDelete}
                  onClick={() =>
                    void run(async () => {
                      await p.onEdit(preview);
                      setPreviewId(null);
                    })
                  }
                >
                  用这张图开始编辑
                </button>
                <button
                  disabled={locked || preview.pendingDelete}
                  onClick={() => void run(() => saveImage(preview))}
                >
                  另存为
                </button>
                <button
                  className="danger"
                  disabled={locked}
                  onClick={() => {
                    setError("");
                    setDeleteIds([preview.id]);
                  }}
                >
                  <Trash size={16} />
                  删除
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
      {!!deleteIds.length && (
        <Modal
          title="删除图库图片"
          onClose={() => {
            if (!busy) {
              setDeleteIds([]);
              setError("");
            }
          }}
        >
          <p>
            永久删除 {deleteIds.length}{" "}
            张图片及其图库文件？本机导入源文件和当前任务中的工作副本会保留。
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <button
              disabled={busy}
              onClick={() => {
                setDeleteIds([]);
                setError("");
              }}
            >
              取消
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void run(remove)}
            >
              {busy ? "正在删除…" : "确认删除图片"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
