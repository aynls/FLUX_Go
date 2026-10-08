import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Images,
  Plus,
  Clipboard,
  Trash,
  ArrowLeft,
  Eye,
  Copy,
} from "@phosphor-icons/react";
import { save } from "@tauri-apps/plugin-dialog";
import type { GalleryItem } from "../lib/types";
import * as api from "../lib/api";
import { activeLocale, m, formatDate, formatDateTime } from "../i18n";
import { modelLabel } from "../labels";
import { modelByAnyId } from "../models/catalog";
import { exportDefaultPath } from "../lib/export";
import Modal from "./Modal";
import GenerationInfo from "./GenerationInfo";

export default function Gallery(p: {
  items: GalleryItem[];
  error: string;
  importing: boolean;
  saveDirectory: string;
  onRefresh: () => Promise<void>;
  onFiles: () => void;
  onPaste: () => void;
  onUse: (ids: string[]) => Promise<void>;
  onEdit: (item: GalleryItem) => Promise<void | boolean>;
  picker?: { limit: number; usedIds: string[] };
}) {
  const [filter, setFilter] = useState("all");
  const [selection, setSelection] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(!!p.picker);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
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
            item.model &&
              modelLabel(
                item.model,
                modelByAnyId(item.model)?.label ?? item.model,
              ),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
      ),
    [p.items, filter, query, activeLocale()],
  );
  const preview = p.items.find((item) => item.id === previewId);
  const groups = new Map<string, GalleryItem[]>();
  for (const item of filtered.slice(0, visibleCount)) {
    const date = formatDate(item.createdAt);
    groups.set(date, [...(groups.get(date) ?? []), item]);
  }
  useEffect(() => {
    setSelection((ids) =>
      ids.filter((id) => p.items.some((i) => i.id === id && !i.pendingDelete)),
    );
  }, [p.items]);
  useEffect(() => setVisibleCount(120), [query, filter]);
  useEffect(() => setCopiedId(null), [previewId]);
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
      filters: [{ name: m.file_image(), extensions: [ext] }],
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
          <h2>{p.picker ? m.gallery_pick() : m.gallery()}</h2>
          <span className="muted">
            {m.count_images({ count: p.items.length })}
          </span>
        </div>
        <div className="row">
          <button disabled={locked} onClick={p.onFiles}>
            <Plus size={16} />
            {m.gallery_import()}
          </button>
          <button disabled={locked} onClick={p.onPaste}>
            <Clipboard size={16} />
            {m.gallery_paste()}
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
              {selecting ? m.gallery_done() : m.gallery_select()}
            </button>
          )}
        </div>
      </div>
      <div className="gallery-filters">
        <div className="segmented" aria-label={m.gallery_source()}>
          {(
            [
              ["all", m.gallery_all()],
              ["generated", m.gallery_generated()],
              ["imported", m.gallery_imported()],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-label={m.gallery_filter({ label })}
              aria-pressed={filter === value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          aria-label={m.gallery_search()}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={m.gallery_search_placeholder()}
        />
      </div>
      {p.picker && (
        <p className="gallery-hint">
          {m.gallery_room({
            count: Math.max(0, limit - selection.length),
          })}
        </p>
      )}
      {(error || p.error) && (
        <div className="gallery-error" role="alert">
          {error || p.error}
          <button onClick={() => void run(p.onRefresh)}>{m.gallery_refresh()}</button>
        </div>
      )}
      {p.importing && (
        <p className="gallery-hint" role="status">
          {m.gallery_saving()}
        </p>
      )}
      <div className="gallery-scroll">
        {!filtered.length && (
          <div className="gallery-empty">
            <Images size={44} weight="thin" />
            <strong>
              {p.items.length ? m.gallery_no_match() : m.gallery_empty_title()}
            </strong>
            <p>
              {p.items.length
                ? m.gallery_no_match_help()
                : m.gallery_empty_help()}
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
                        selecting
                          ? m.gallery_select_named({ name: item.name })
                          : m.gallery_view_named({ name: item.name })
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
                          {m.gallery_delete_incomplete()}
                        </span>
                      ) : already ? (
                        <span className="gallery-tile-label">
                          {m.gallery_in_task()}
                        </span>
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
                        aria-label={m.gallery_preview_named({ name: item.name })}
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
            {m.gallery_load_more({ count: filtered.length - visibleCount })}
          </button>
        )}
      </div>
      {selecting && (
        <div
          className="gallery-selection"
          role="region"
          aria-label={m.gallery_selection_actions()}
        >
          <span>{m.gallery_selected({ count: selection.length })}</span>
          <button
            disabled={locked || !selection.length}
            onClick={() => setSelection([])}
          >
            {m.gallery_clear()}
          </button>
          <button
            className="primary"
            disabled={locked || !selection.length}
            onClick={() => void run(() => p.onUse(selection))}
          >
            {selection.length
              ? m.gallery_add_refs_count({ count: selection.length })
              : m.gallery_add_refs()}
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
              {m.action_delete()}
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
                ? modelLabel(
                    preview.model,
                    modelByAnyId(preview.model)?.label ?? preview.model,
                  )
                : m.gallery_imported_image()}
            </span>
            <span>{formatDateTime(preview.createdAt)}</span>
          </div>
          <GenerationInfo details={preview.details} />
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
              {m.gallery_back()}
            </button>
            <button
              disabled={locked || preview.pendingDelete}
              onClick={() =>
                void run(async () => {
                  await api.copyImage((await api.galleryRead(preview.id)).dataUrl);
                  setCopiedId(preview.id);
                })
              }
            >
              <Copy size={16} />
              {copiedId === preview.id ? m.gallery_copied() : m.action_copy_image()}
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
                {selection.includes(preview.id)
                  ? m.gallery_unselect()
                  : m.gallery_select_this()}
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
                  {m.gallery_add_refs()}
                </button>
                <button
                  className="primary"
                  disabled={locked || preview.pendingDelete}
                  onClick={() =>
                    void run(async () => {
                      if ((await p.onEdit(preview)) !== false)
                        setPreviewId(null);
                    })
                  }
                >
                  {m.gallery_edit_this()}
                </button>
                <button
                  disabled={locked || preview.pendingDelete}
                  onClick={() => void run(() => saveImage(preview))}
                >
                  {m.action_save_as()}
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
                  {m.action_delete()}
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
      {!!deleteIds.length && (
        <Modal
          title={m.gallery_delete_title()}
          onClose={() => {
            if (!busy) {
              setDeleteIds([]);
              setError("");
            }
          }}
        >
          <p>
            {m.gallery_delete_body({ count: deleteIds.length })}
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
              {m.action_cancel()}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void run(remove)}
            >
              {busy ? m.gallery_deleting() : m.gallery_confirm_delete()}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
