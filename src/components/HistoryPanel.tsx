import { useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ArrowClockwise, ArrowLeft, Trash } from "@phosphor-icons/react";
import { assetUrl, historyDelete, importImage, saveDataUrl } from "../lib/api";
import type { HistoryItem } from "../lib/types";
import { exportDefaultPath } from "../lib/export";
import { modelByAnyId, providers } from "../models/catalog";
import Modal from "./Modal";
import { displayValue } from "../workspaces/shared/Controls";
import { catalog } from "../models/catalog";

interface Props {
  onCancel?: (id: string) => void;
  saveDirectory: string;
  items: HistoryItem[];
  onRefresh: () => void;
  onUseAsInput: (item: HistoryItem) => void;
  onRestoreEdit: (item: HistoryItem) => void;
}

export default function HistoryPanel({
  onCancel,
  saveDirectory,
  items,
  onRefresh,
  onUseAsInput,
  onRestoreEdit,
}: Props) {
  const [error, setError] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = items.find((it) => it.id === detailId) ?? null;

  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const canDelete = (it: HistoryItem) =>
    it.status !== "queued" && it.status !== "running";
  const deletable = items.filter(canDelete);
  const selected = deletable.filter((it) => selectedIds.has(it.id));
  const toggle = (id: string) =>
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const confirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setError("");
    const failed: string[] = [];
    const removed = new Set<string>();
    try {
      for (const id of deleteIds) {
        try {
          await historyDelete(id);
          removed.add(id);
        } catch (e) {
          failed.push(String(e));
        }
      }
      if (removed.has(detailId ?? "")) setDetailId(null);
      setSelectedIds(
        (previous) => new Set([...previous].filter((id) => !removed.has(id))),
      );
      setDeleteIds([]);
      if (failed.length)
        setError(`有 ${failed.length} 条记录删除失败：${failed[0]}`);
      else {
        setBatchMode(false);
        setSelectedIds(new Set());
      }
      onRefresh();
    } finally {
      setDeleting(false);
    }
  };
  const confirmation = deleteIds.length > 0 && (
    <Modal
      title="确认删除历史记录"
      onClose={() => {
        if (!deleting) setDeleteIds([]);
      }}
    >
      <p>
        确定删除 {deleteIds.length}{" "}
        条历史记录？图片文件会保留，历史记录删除后无法撤销。
      </p>
      <div className="history-delete-actions">
        <button disabled={deleting} onClick={() => setDeleteIds([])}>
          取消
        </button>
        <button
          className="danger"
          disabled={deleting}
          onClick={() => void confirmDelete()}
        >
          {deleting ? "删除中…" : "确认删除"}
        </button>
      </div>
    </Modal>
  );
  if (detail) {
    return (
      <>
        <HistoryDetail
          saveDirectory={saveDirectory}
          item={detail}
          onCancel={() => onCancel?.(detail.id)}
          onBack={() => setDetailId(null)}
          onUseAsInput={(index = 0) => {
            onUseAsInput({
              ...detail,
              resultFiles: [detail.resultFiles[index]],
            });
            setDetailId(null);
          }}
          onRestoreEdit={() => {
            onRestoreEdit(detail);
            setDetailId(null);
          }}
          onDelete={() => {
            setError("");
            setDeleteIds([detail.id]);
          }}
          error={error}
        />
        {confirmation}
      </>
    );
  }
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="history-list-toolbar">
          <span className="text-xs text-zinc-500">共 {items.length} 条</span>
          <div className="row">
            <button
              disabled={!deletable.length && !batchMode}
              onClick={() => {
                setBatchMode(!batchMode);
                setSelectedIds(new Set());
                setError("");
              }}
            >
              {batchMode ? "取消选择" : "批量删除"}
            </button>
            <button onClick={onRefresh}>
              <ArrowClockwise size={14} /> 刷新
            </button>
          </div>
        </div>
        {batchMode && (
          <div className="history-batch-toolbar">
            <button
              disabled={!deletable.length}
              onClick={() =>
                setSelectedIds(
                  selected.length === deletable.length
                    ? new Set()
                    : new Set(deletable.map((it) => it.id)),
                )
              }
            >
              {selected.length > 0 && selected.length === deletable.length
                ? "取消全选"
                : "全选"}
            </button>
            <span className="muted">已选 {selected.length} 条</span>
            <button
              className="danger"
              disabled={!selected.length}
              onClick={() => setDeleteIds(selected.map((it) => it.id))}
            >
              删除所选
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="error-text history-list-error">
            {error}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <p className="text-xs text-zinc-500">暂无生成记录</p>
          ) : (
            <div className="flex flex-col gap-2">
              {items.map((it, index) => (
                <div
                  key={it.id}
                  className={
                    "history-row" +
                    (batchMode && selectedIds.has(it.id) ? " selected" : "")
                  }
                >
                  {batchMode && (
                    <input
                      type="checkbox"
                      aria-label={"选择第 " + (index + 1) + " 条历史记录"}
                      checked={selectedIds.has(it.id) && canDelete(it)}
                      disabled={!canDelete(it)}
                      onChange={() => toggle(it.id)}
                    />
                  )}
                  <button
                    className="history-row-content"
                    disabled={batchMode && !canDelete(it)}
                    onClick={() =>
                      batchMode ? toggle(it.id) : setDetailId(it.id)
                    }
                  >
                    {it.thumbFile || it.thumb ? (
                      <img
                        src={it.thumbFile ? assetUrl(it.thumbFile) : it.thumb!}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] text-zinc-500">
                        {historyStatus(it)}
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
                      <span className="muted">
                        {modelByAnyId(it.model)?.label ?? it.model} ·{" "}
                        {historyStatus(it)}
                      </span>
                    </div>
                  </button>
                  {!batchMode && canDelete(it) && (
                    <button
                      className="history-row-delete danger"
                      aria-label={"删除第 " + (index + 1) + " 条历史记录"}
                      title="删除记录"
                      onClick={() => {
                        setError("");
                        setDeleteIds([it.id]);
                      }}
                    >
                      <Trash size={18} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {confirmation}
    </>
  );
}

function HistoryDetail({
  onCancel,
  saveDirectory,
  item,
  onBack,
  onUseAsInput,
  onRestoreEdit,
  onDelete,
  error,
}: {
  onCancel: () => void;
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
  const [preview, setPreview] = useState<{ src: string; title: string } | null>(
    null,
  );
  const resultFile = item.resultFiles[resultIndex];
  const resultSrc = resultFile ? assetUrl(resultFile) : null;
  const inputSrc = item.inputFiles[0] ? assetUrl(item.inputFiles[0]) : null;

  const saveAs = async () => {
    if (!resultFile) return;
    const ext = /\.(jpe?g|webp)$/i.exec(resultFile)?.[1].toLowerCase() ?? "png";
    const path = await saveDialog({
      defaultPath: exportDefaultPath(
        saveDirectory,
        `lutriui-${item.id.slice(0, 8)}${resultIndex ? "-" + (resultIndex + 1) : ""}.${ext}`,
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
    <div className="history-detail flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <button
        className="history-back mb-2 self-start text-xs text-zinc-400 hover:text-zinc-200"
        onClick={onBack}
      >
        <ArrowLeft size={12} /> 返回列表
      </button>

      {resultSrc && (
        <button
          className="history-image-button"
          aria-label="放大查看历史结果"
          onClick={() => setPreview({ src: resultSrc, title: "历史生成结果" })}
        >
          <img
            src={resultSrc}
            alt="结果"
            className="w-full rounded-md border border-zinc-800"
          />
        </button>
      )}
      {!resultSrc && item.resultFiles.length > 0 && (
        <p className="help">这张结果图片已从图库删除，生成参数仍然保留。</p>
      )}
      {item.resultFiles.length > 1 && (
        <div className="result-gallery mt-2" aria-label="历史生成结果">
          {item.resultFiles.map((path, i) => (
            <button
              key={i}
              className={resultIndex === i ? "active" : ""}
              aria-label={"历史结果 " + (i + 1)}
              onClick={() => setResultIndex(i)}
            >
              {path ? (
                <img src={assetUrl(path)} alt={"历史结果 " + (i + 1)} />
              ) : (
                <span className="help">图片已删除</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <Meta label="任务状态" value={historyStatus(item)} />
        <Meta
          label="模式"
          value={item.mode === "edit" ? "图像编辑" : "文生图"}
        />
        <Meta label="时间" value={new Date(item.createdAt).toLocaleString()} />
        <Meta
          label="提供商"
          value={
            providers.find((p) => p.id === item.provider)?.label ??
            item.provider
          }
        />
        <Meta
          label="模型"
          value={modelByAnyId(item.model)?.label ?? item.model}
        />
        {(item.provider !== "comfy" || item.usage?.credits != null) && (
          <Meta
            label="成本"
            value={
              item.provider === "comfy"
                ? item.usage?.credits != null
                  ? `${item.usage.credits} Credits`
                  : ""
                : item.cost !== null
                  ? `$${item.cost.toFixed(4)}`
                  : "-"
            }
          />
        )}
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
        {item.batch && (
          <Meta
            label="生成张数"
            value={`${item.resultFiles.length} / ${item.batch.requests.length} 张`}
          />
        )}
      </div>
      {item.error && <p className="error-text">{item.error}</p>}
      {item.taskId && <p className="help">供应商任务：{item.taskId}</p>}
      {(item.status === "queued" || item.status === "running") &&
        item.batch?.requests.some((request) => request.status === "queued") && (
          <button onClick={onCancel}>停止尚未发送的请求</button>
        )}

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
        <summary>生成参数</summary>
        <dl className="request-parameters">
          {Object.entries(item.params)
            .filter(
              ([key, value]) =>
                catalog.fields[key] &&
                value != null &&
                !(item.batch && key === "count") &&
                !(
                  item.batch &&
                  item.batch.requests.length > 1 &&
                  key === "seed"
                ),
            )
            .map(([key, value]) => (
              <div key={key}>
                <dt>{catalog.fields[key].label}</dt>
                <dd>{displayValue(key, value as string | number | boolean)}</dd>
              </div>
            ))}
        </dl>
      </details>

      {item.batch && item.batch.requests.length > 1 && (
        <details className="mt-3">
          <summary>逐张请求详情</summary>
          {item.batch.requests.map((request, i) => (
            <div key={request.requestId} className="help">
              第 {i + 1} 张 ·{" "}
              {
                {
                  queued: "等待执行",
                  running: "执行中",
                  ok: "已完成",
                  failed: "失败",
                  skipped: "未执行",
                  interrupted: "已中断",
                }[request.status]
              }
              {request.seed != null && ` · 种子 ${request.seed}`}
              {request.taskId && <p>供应商任务：{request.taskId}</p>}
              {request.error && <p className="error-text">{request.error}</p>}
            </div>
          ))}
        </details>
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
          <p className="mb-1 text-xs text-zinc-500">
            当时的素材 · {item.inputFiles.length}
          </p>
          <div className="result-gallery">
            {item.inputFiles.map((path, i) => (
              <button
                key={path}
                aria-label={"查看历史素材 " + (i + 1)}
                onClick={() =>
                  setPreview({
                    src: assetUrl(path),
                    title: item.recipe?.refNames[i] ?? "素材 " + (i + 1),
                  })
                }
              >
                <img
                  src={assetUrl(path)}
                  alt={item.recipe?.refNames[i] ?? "素材 " + (i + 1)}
                />
              </button>
            ))}
          </div>
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
          disabled={item.status === "queued" || item.status === "running"}
        >
          <Trash size={12} /> 删除记录
        </button>
      </div>
      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} large>
          <div className="image-preview">
            <img src={preview.src} alt={preview.title} />
          </div>
        </Modal>
      )}
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
function historyStatus(item: HistoryItem) {
  const phases: Record<string, string> = {
    preparing: "准备素材",
    submitting: "提交中",
    queued: "供应商排队",
    generating: "生成中",
    waiting: "等待结果",
    downloading: "下载结果",
    reasoning: "处理中",
    saving: "保存结果",
  };
  const status =
    item.status === "running"
      ? (phases[item.phase ?? ""] ?? "执行中")
      : ((
          {
            queued: "等待执行",
            ok: "已完成",
            failed: "失败",
            cancelled: "已取消",
            interrupted: "已中断",
            partial: "部分完成",
          } as Record<string, string>
        )[item.status] ?? item.status);
  return item.batch && item.batch.requests.length > 1
    ? `${status} · ${item.batch.requests.filter((request) => request.status === "ok").length}/${item.batch.requests.length} 张`
    : status;
}
