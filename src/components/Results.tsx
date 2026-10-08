import Canvas from "./Canvas";
import GenerationInfo from "./GenerationInfo";
import { getResultBase, type SavedResult } from "../app/generation";
import type { WorkingImage } from "../lib/types";
import { taskIntent } from "../lib/workspace";
import { localizeStored, m } from "../i18n";
import { modelLabel, providerLabel } from "../labels";
import { modelByAnyId } from "../models/catalog";
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
            <img src={base.dataUrl} alt={m.result_original_full()} />
          )}
          <img src={image.dataUrl} alt={m.result_full()} />
        </div>
      ) : view === "compare" && base ? (
        <div className="comparison">
          <figure>
            <figcaption>{m.result_original_caption()}</figcaption>
            <img src={base.dataUrl} alt={m.result_original()} />
          </figure>
          <figure>
            <figcaption>
              {m.result_size({ width: image.width, height: image.height })}
            </figcaption>
            <img src={image.dataUrl} alt={m.result_alt()} />
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
      aria-label={m.result_log()}
    >
      {!p.compact && (
        <button
          className="result-panel-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          <strong>{m.result_log()}</strong>
          <span className="muted">
            {m.result_batches({
              batches: p.attempts?.length || 1,
              count: r.out.images.length,
            })}
          </span>
          <span className="result-panel-toggle-label">
            {expanded ? m.action_collapse() : m.action_expand()}
            {expanded ? <CaretDown size={16} /> : <CaretUp size={16} />}
          </span>
        </button>
      )}
      {(p.compact || expanded) && (
        <div className="result-actions" id={contentId}>
          {!p.compact && multipleAttempts && (
            <div className="result-gallery-group">
              <h3>{m.result_recent()}</h3>
              <div className="result-gallery" aria-label={m.result_attempts()}>
                {p.attempts!.map((attempt, i) => (
                  <button
                    key={attempt.item.id}
                    className={attempt.item.id === r.item.id ? "active" : ""}
                    aria-label={m.result_view_attempt({ index: i + 1 })}
                    aria-pressed={attempt.item.id === r.item.id}
                    title={
                      m.result_attempt({ time: i + 1 }) +
                      " · " +
                      m.count_images({ count: attempt.out.images.length })
                    }
                    onClick={() => p.onAttempt?.(attempt)}
                  >
                    <img
                      src={attempt.image.dataUrl}
                      alt={m.result_attempt_alt({ index: i + 1 })}
                    />
                  </button>
                ))}
              </div>
            </div>
          )}
          {!p.compact &&
            r.out.images.length > 0 &&
            (!multipleAttempts || r.out.images.length > 1) && (
              <div className="result-gallery-group">
                <h3>{m.result_current({ count: r.out.images.length })}</h3>
                <div
                  className="result-gallery"
                  aria-label={m.result_current_images()}
                >
                  {r.out.images.map((im, i) => (
                    <button
                      className={i === r.selectedIndex ? "active" : ""}
                      key={i}
                      onClick={() => p.onSelect(i)}
                      aria-label={m.result_view({ index: i + 1 })}
                      aria-pressed={i === r.selectedIndex}
                    >
                      <img
                        src={im.dataUrl}
                        alt={m.result_n_alt({ index: i + 1 })}
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}
          <div className="result-heading">
            <strong>
              {modelLabel(
                r.out.model,
                modelByAnyId(r.out.model)?.label ?? m.result_latest(),
              )}
            </strong>
            <span className="result-save-state">
              {r.saved ? m.result_saved() : m.result_unsaved()}
            </span>
          </div>
          <div className="result-meta">
            <span>{providerLabel(r.out.provider)}</span>
            <span>
              {r.image.width}×{r.image.height}
            </span>
            {r.out.provider === "comfy" ? (
              r.out.usage?.credits != null && (
                <span>{m.history_credits({ value: r.out.usage.credits })}</span>
              )
            ) : r.item.cost != null ? (
              <span>${r.item.cost.toFixed(4)}</span>
            ) : r.out.usage?.credits != null ? (
              <span>{m.history_credits({ value: r.out.usage.credits })}</span>
            ) : null}
          </div>
          <div className="result-operations">
            <div className="result-secondary">
              <button onClick={p.onSave}>{m.action_save_as()}</button>
              <button onClick={p.onCopy}>{m.action_copy_image()}</button>
              <button onClick={() => p.onUse(r.image, false)}>
                {m.result_add_ref()}
              </button>
            </div>
            <button className="primary" onClick={() => p.onUse(r.image, true)}>
              {taskIntent(r.snapshot) === "edit"
                ? m.result_continue()
                : m.result_start_edit()}
            </button>
            {!r.saved && (
              <button disabled={p.saving} onClick={p.onRetry}>
                {m.result_resave()}
              </button>
            )}
          </div>
          <GenerationInfo details={r.out.images[r.selectedIndex]?.details} />
          {r.out.notes.length > 0 && (
            <details>
              <summary>{m.result_provider_notes()}</summary>
              {r.out.notes.map((n, i) => (
                <p className="help" key={i}>
                  {localizeStored(n)}
                </p>
              ))}
            </details>
          )}
        </div>
      )}
    </section>
  );
}
