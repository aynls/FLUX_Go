import { useState } from "react";
import Modal from "./Modal";
import { primaryImage, editReferences } from "../lib/workspace";
import { modelById, providers, routeFor } from "../models/catalog";
import type { Draft, WorkingImage } from "../lib/types";
import { m } from "../i18n";
import { modelLabel, providerLabel } from "../labels";

export default function EditHandoff(p: {
  draft: Draft;
  image: WorkingImage;
  onDecision: (keepReferences: boolean | null) => void;
}) {
  const [keep, setKeep] = useState(false);
  const main = primaryImage(p.draft);
  const references = editReferences(p.draft, p.image);
  const max = routeFor(p.draft)?.maxRefs ?? 0;
  const cleared = [
    p.draft.prompt.trim() && m.handoff_instruction(),
    p.draft.boxes.length &&
      m.handoff_regions({ count: p.draft.boxes.length }),
    p.draft.mask && m.handoff_mask(),
  ].filter(Boolean);
  const model = modelById(p.draft.modelId);
  return (
    <Modal title={m.handoff_title()} onClose={() => p.onDecision(null)}>
      <div className="edit-handoff-images">
        <figure>
          {main ? (
            <img src={main.dataUrl} alt={m.handoff_current_alt()} />
          ) : (
            <div className="edit-handoff-empty">{m.handoff_no_main()}</div>
          )}
          <figcaption>
            {m.handoff_current({ name: main?.name ?? m.handoff_draft() })}
          </figcaption>
        </figure>
        <figure>
          <img src={p.image.dataUrl} alt={m.handoff_next_alt()} />
          <figcaption>
            {m.handoff_replace_with({ name: p.image.name })}
          </figcaption>
        </figure>
      </div>
      <p>
        {m.handoff_model({
          model: modelLabel(model?.id, model?.label ?? ""),
          provider: providerLabel(
            providers.find((v) => v.id === p.draft.provider)?.id,
          ),
        })}
      </p>
      {cleared.length > 0 && (
        <p className="help">
          {m.handoff_clears({ items: cleared.join("、") })}
        </p>
      )}
      {references.length > 0 && (
        <label className="check">
          <input
            type="checkbox"
            checked={keep}
            onChange={(e) => setKeep(e.target.checked)}
          />
          {m.handoff_keep({ count: references.length })}
        </label>
      )}
      {keep && (
        <p className="help">{references.map((r) => r.name).join("、")}</p>
      )}
      {keep && references.length + 1 > max && (
        <p className="error-text">{m.handoff_too_many({ count: max })}</p>
      )}
      <div className="row close-actions">
        <button onClick={() => p.onDecision(null)}>{m.action_cancel()}</button>
        <button
          className="primary"
          disabled={keep && references.length + 1 > max}
          onClick={() => p.onDecision(keep)}
        >
          {m.handoff_replace()}
        </button>
      </div>
    </Modal>
  );
}
