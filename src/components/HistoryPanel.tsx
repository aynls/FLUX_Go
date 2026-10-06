import { useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ArrowClockwise, ArrowLeft, Trash } from "@phosphor-icons/react";
import { assetUrl, historyDelete, importImage, saveDataUrl } from "../lib/api";
import type { HistoryItem } from "../lib/types";
import { exportDefaultPath } from "../lib/export";

interface Props {
  saveDirectory: string;
  items: HistoryItem[];
  onRefresh: () => void;
  onUseAsInput: (item: HistoryItem) => void;
  onRestoreEdit: (item: HistoryItem) => void;
}

export default function HistoryPanel({
  saveDirectory,
  items,
  onRefresh,
  onUseAsInput,
  onRestoreEdit,
}: Props) {
  const [error, setError] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = items.find((it) => it.id === detailId) ?? null;

  if (detail) {
    return (
      <HistoryDetail
        saveDirectory={saveDirectory}
        item={detail}
        onBack={() => setDetailId(null)}
        onUseAsInput={(index = 0) => {
          onUseAsInput({ ...detail, resultFiles: [detail.resultFiles[index]] });
          setDetailId(null);
        }}
        onRestoreEdit={() => {
          onRestoreEdit(detail);
          setDetailId(null);
        }}
        onDelete={async () => {
          if (!window.confirm("确定删除这条历史记录及其图片文件？")) return;
          try {
            await historyDelete(detail.id);
            setDetailId(null);
            onRefresh();
          } catch (e) {
            setError("删除失败：" + String(e));
          }
        }}
        error={error}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3">
        <span className="text-xs text-zinc-500">共 {items.length} 条</span>
        <button
          className="flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-zinc-100"
          onClick={onRefresh}
        >
          <ArrowClockwise size={11} /> 刷新
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {items.length === 0 ? (
          <p className="text-xs text-zinc-500">暂无生成记录</p>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((it) => (
              <button
                key={it.id}
                className="flex gap-2.5 rounded-md border border-zinc-800/80 p-2 text-left transition-colors hover:border-zinc-600 hover:bg-white/[0.02]"
                onClick={() => setDetailId(it.id)}
              >
                {it.thumb ? (
                  <img
                    src={it.thumb}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] text-zinc-500">
                    无图
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                    <span className="rounded bg-zinc-800 px-1">
                      {it.mode === "edit" ? "编辑" : "文生图"}
                    </span>
                    <span>{new Date(it.createdAt).toLocaleString()}</span>
                    {(it.cost !== null || it.usage?.credits != null) && (
                      <span className="text-emerald-500">
                        {it.provider === "comfy"
                          ? `${it.usage?.credits ?? "未返回"} Credits`
                          : it.cost !== null
                            ? `$${it.cost.toFixed(3)}`
                            : "费用未返回"}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-zinc-300">
                    {it.prompt || "（无提示词）"}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryDetail({
  saveDirectory,
  item,
  onBack,
  onUseAsInput,
  onRestoreEdit,
  onDelete,
  error,
}: {
  saveDirectory: string;
  item: HistoryItem;
  onBack: () => void;
  onUseAsInput: (index?: number) => void;
  onRestoreEdit: () => void;
  onDelete: () => void;
  error: string;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [resultIndex, setResultIndex] = useState(0);
  const resultFile = item.resultFiles[resultIndex];
  const resultSrc = resultFile ? assetUrl(resultFile) : null;
  const inputSrc = item.inputFiles[0] ? assetUrl(item.inputFiles[0]) : null;

  const saveAs = async () => {
    if (!resultFile) return;
    const ext = /\.(jpe?g|webp)$/i.exec(resultFile)?.[1].toLowerCase() ?? "png";
    const path = await saveDialog({
      defaultPath: exportDefaultPath(
        saveDirectory,
        `flux-${item.id.slice(0, 8)}${resultIndex ? "-" + (resultIndex + 1) : ""}.${ext}`,
      ),
      filters: [{ name: "图片", extensions: [ext] }],
    });
    if (!path) return;
    setSaving(true);
    try {
      const img = await importImage(resultFile);
      await saveDataUrl(img.dataUrl, path);
    } catch (e) {
      setSaveError("保存失败：" + String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <button
        className="mb-2 self-start text-xs text-zinc-400 hover:text-zinc-200"
        onClick={onBack}
      >
        <ArrowLeft size={12} /> 返回列表
      </button>

      {resultSrc && (
        <img
          src={resultSrc}
          alt="结果"
          className="w-full rounded-md border border-zinc-800"
        />
      )}
      {item.resultFiles.length > 1 && (
        <div className="result-gallery mt-2" aria-label="历史生成结果">
          {item.resultFiles.map((path, i) => (
            <button
              key={path}
              className={resultIndex === i ? "active" : ""}
              aria-label={"历史结果 " + (i + 1)}
              onClick={() => setResultIndex(i)}
            >
              <img src={assetUrl(path)} alt={"历史结果 " + (i + 1)} />
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <Meta
          label="模式"
          value={item.mode === "edit" ? "图像编辑" : "文生图"}
        />
        <Meta label="时间" value={new Date(item.createdAt).toLocaleString()} />
        <Meta label="提供商" value={item.provider} />
        <Meta label="模型" value={item.model} />
        <Meta
          label="成本"
          value={
            item.provider === "comfy"
              ? item.usage?.credits != null
                ? `${item.usage.credits} Credits`
                : "实际 Credits 未返回"
              : item.cost !== null
                ? `$${item.cost.toFixed(4)}`
                : "-"
          }
        />
        <Meta
          label="Tokens"
          value={
            item.usage?.total_tokens ? String(item.usage.total_tokens) : "-"
          }
        />
        <Meta
          label="画布"
          value={
            item.canvasWidth ? `${item.canvasWidth}×${item.canvasHeight}` : "-"
          }
        />
        <Meta label="包围盒" value={`${(item.boxes ?? []).length} 个`} />
      </div>

      <div className="mt-3">
        <p className="mb-1 text-xs text-zinc-500">提示词</p>
        <p className="whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900 p-2 text-xs leading-relaxed text-zinc-300">
          {item.prompt || "（空）"}
        </p>
      </div>

      {(item.boxes ?? []).length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-zinc-500">包围盒（画布像素坐标）</p>
          <div className="flex flex-col gap-1">
            {(
              item.boxes as {
                id: string;
                role: string;
                rect: { x: number; y: number; w: number; h: number };
                desc: string;
              }[]
            ).map((b) => (
              <div
                key={b.id}
                className="rounded border border-zinc-800 px-2 py-1 font-mono text-[10px] text-zinc-400"
              >
                {b.id} [{Math.round(b.rect.x)}, {Math.round(b.rect.y)},{" "}
                {Math.round(b.rect.w)}, {Math.round(b.rect.h)}] {b.desc}
              </div>
            ))}
          </div>
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-zinc-500">
          最终发送的提示词
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-zinc-800 bg-zinc-900 p-2 text-[10px] text-zinc-500">
          {item.finalPrompt}
        </pre>
      </details>

      {inputSrc && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-zinc-500">当时的输入图</p>
          <img
            src={inputSrc}
            alt="输入"
            className="max-h-48 rounded border border-zinc-800"
          />
        </div>
      )}

      {(error || saveError) && (
        <p role="alert" className="error-text">
          {error || saveError}
        </p>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 pb-2">
        <button
          className="rounded-md border border-zinc-700 px-3 py-2 text-xs hover:border-zinc-500"
          onClick={() => onUseAsInput(resultIndex)}
          disabled={!resultSrc}
        >
          作为当前输入继续编辑
        </button>
        <button
          className="rounded-md border border-zinc-700 px-3 py-2 text-xs hover:border-zinc-500"
          onClick={onRestoreEdit}
        >
          恢复完整方案
        </button>
        <button
          className="rounded-md border border-zinc-700 px-3 py-2 text-xs hover:border-zinc-500"
          onClick={saveAs}
          disabled={!resultSrc || saving}
        >
          {saving ? "保存中…" : "另存为…"}
        </button>
        <button
          className="rounded-md border border-red-900/60 px-3 py-2 text-xs text-red-400 hover:border-red-700"
          onClick={onDelete}
        >
          <Trash size={12} /> 删除记录
        </button>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className="truncate text-zinc-300" title={value}>
        {value}
      </span>
    </div>
  );
}
