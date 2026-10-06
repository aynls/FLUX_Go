import { useState } from "react";
import Modal from "./Modal";
import { primaryImage, editReferences } from "../lib/workspace";
import { modelById, providers, routeFor } from "../models/catalog";
import type { Draft, WorkingImage } from "../lib/types";

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
    p.draft.prompt.trim() && "编辑指令",
    p.draft.boxes.length && `${p.draft.boxes.length} 个区域`,
    p.draft.mask && "蒙版",
  ].filter(Boolean);
  return (
    <Modal title="开始新的图片编辑" onClose={() => p.onDecision(null)}>
      <div className="edit-handoff-images">
        <figure>
          {main ? (
            <img src={main.dataUrl} alt="当前编辑主图" />
          ) : (
            <div className="edit-handoff-empty">尚无主图</div>
          )}
          <figcaption>当前：{main?.name ?? "编辑草稿"}</figcaption>
        </figure>
        <figure>
          <img src={p.image.dataUrl} alt="新的编辑主图" />
          <figcaption>替换为：{p.image.name}</figcaption>
        </figure>
      </div>
      <p>
        编辑模型：{modelById(p.draft.modelId)?.label} ·{" "}
        {providers.find((v) => v.id === p.draft.provider)?.label}
      </p>
      {cleared.length > 0 && (
        <p className="help">
          新一轮编辑会清空{cleared.join("、")}，可撤销恢复。
        </p>
      )}
      {references.length > 0 && (
        <label className="check">
          <input
            type="checkbox"
            checked={keep}
            onChange={(e) => setKeep(e.target.checked)}
          />
          沿用其他参考素材（{references.length} 张）
        </label>
      )}
      {keep && (
        <p className="help">{references.map((r) => r.name).join("、")}</p>
      )}
      {keep && references.length + 1 > max && (
        <p className="error-text">
          此模型最多接收 {max} 张图片，请取消沿用参考素材。
        </p>
      )}
      <div className="row close-actions">
        <button onClick={() => p.onDecision(null)}>取消</button>
        <button
          className="primary"
          disabled={keep && references.length + 1 > max}
          onClick={() => p.onDecision(keep)}
        >
          替换并开始编辑
        </button>
      </div>
    </Modal>
  );
}
