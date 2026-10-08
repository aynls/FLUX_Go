import {
  ArrowUp,
  ArrowDown,
  Eye,
  Trash,
  Plus,
  DotsThree,
} from "@phosphor-icons/react";
import { m } from "../../i18n";
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
  galleryIds?: string[];
  ready: boolean;
  importing: boolean;
  onChange: (d: Draft, discrete?: boolean) => void;
  onPreview: (id: string) => void;
  onFiles: () => void;
  onGallery: () => void;
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
          {m.references()}{" "}
          <span className="muted">
            {d.refs.length}/{max}
          </span>
        </h2>
        <div className="reference-add">
          <button disabled={disabled} onClick={p.onFiles}>
            <Plus size={14} />
            {m.references_add_file()}
          </button>
          <details
            className="action-menu"
            onClick={closeAction}
            onKeyDown={closeKey}
          >
            <summary aria-label={m.references_more()}>
              <DotsThree size={18} />
            </summary>
            <div className="menu-popover">
              <button disabled={disabled} onClick={p.onPaste}>
                {m.references_paste()}
              </button>
              <button disabled={disabled} onClick={p.onUrl}>
                {m.references_url()}
              </button>
            </div>
          </details>
        </div>
      </div>
      <button
        className="reference-gallery-button"
        disabled={disabled}
        onClick={p.onGallery}
      >
        {m.references_gallery()}
      </button>
      {!d.refs.length && (
        <div className="reference-empty">
          <strong>
            {editing ? m.references_empty_edit() : m.references_empty()}
          </strong>
          <span>{m.references_drop()}</span>
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
                  {isMain ? m.references_main() : m.references_n({ index: i + 1 })}
                </span>
                <details
                  className="action-menu"
                  onClick={closeAction}
                  onKeyDown={closeKey}
                >
                  <summary aria-label={m.references_actions({ name: r.name })}>
                    <DotsThree size={18} />
                  </summary>
                  <div className="menu-popover">
                    {!isMain && (
                      <button onClick={() => makePrimary(r.uid!)}>
                        {m.references_make_main()}
                      </button>
                    )}
                    <button onClick={() => p.onPreview(r.uid!)}>
                      <Eye size={14} />
                      {m.references_view()}
                    </button>
                    <button
                      disabled={i === 0 || (editing && i === 1)}
                      onClick={() => reorder(i, i - 1)}
                    >
                      <ArrowUp size={14} />
                      {m.references_earlier()}
                    </button>
                    <button
                      disabled={isMain || i === d.refs.length - 1}
                      onClick={() => reorder(i, i + 1)}
                    >
                      <ArrowDown size={14} />
                      {m.references_later()}
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (d.mask && i === 0) {
                          p.onNotice(m.notice_mask_blocks_main());
                          return;
                        }
                        if (
                          d.boxes.some((b) => b.sourceId === r.uid) ||
                          d.prompt.includes(`<ref_image_${i}>`)
                        ) {
                          p.onNotice(m.notice_ref_in_use());
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
                      {m.action_remove()}
                    </button>
                  </div>
                </details>
              </div>
              <button
                className="reference-image"
                onClick={() => p.onPreview(r.uid!)}
                aria-label={m.references_preview({ name: r.name })}
              >
                <img src={r.dataUrl} alt={r.name} />
              </button>
              <div className="reference-meta">
                <strong title={r.name}>{r.name}</strong>
                <span>
                  {r.width}×{r.height}
                </span>
                {r.assetId &&
                  p.galleryIds &&
                  !p.galleryIds.includes(r.assetId) && (
                    <span>{m.references_source_gone()}</span>
                  )}
                {!isMain && (
                  <label>
                    {m.references_role()}
                    <select
                      aria-label={m.references_role_label({ name: r.name })}
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
                      <option value="reference">{m.role_reference()}</option>
                      <option value="style">{m.role_style()}</option>
                      <option value="subject">{m.role_subject()}</option>
                      <option value="composition">{m.role_composition()}</option>
                      <option value="custom">{m.role_custom()}</option>
                    </select>
                  </label>
                )}
                {!isMain && r.purpose === "custom" && (
                  <label>
                    {m.role_note()}
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
          {m.show_main()}
        </label>
      )}
    </section>
  );
}
