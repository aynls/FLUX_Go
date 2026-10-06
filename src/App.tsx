import { useGenerationQueue } from "./app/useGenerationQueue";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  GearSix,
  Plus,
} from "@phosphor-icons/react";
import ResizableSidebar from "./components/ResizableSidebar";
import HistoryPanel from "./components/HistoryPanel";
import Settings from "./components/Settings";
import Modal from "./components/Modal";
import References from "./workspaces/shared/References";
import { WorkspaceSidebar, WorkspaceStage } from "./workspaces";
import { useWorkspace } from "./app/useWorkspace";
import * as api from "./lib/api";
import { imageSize } from "./lib/image";
import { exportDefaultPath } from "./lib/export";
import {
  newDraft,
  renameBox,
  withIds,
  validateDraft,
  migrateDraft,
  taskIntent,
  workspaceKey,
  primaryImage,
  setPrimaryImage,
} from "./lib/workspace";
import {
  families,
  familyById,
  modelByAnyId,
  routeFor,
  singleImageDraft,
} from "./models/catalog";
import { compileDraft } from "./models";
import { maskFromRects } from "./workspaces/gpt/mask";
import type {
  Box,
  HistoryItem,
  ProviderStatus,
  WorkingImage,
} from "./lib/types";

import { getResultBase, type SavedResult } from "./app/generation";
import { ResultStage, ResultActions } from "./components/Results";
import { updateFluxBoxes } from "./models/flux/regions";

const FAMILY_ICONS = {
  flux: "/flux.png",
  gpt: "/openai.png",
  qwen: "/qwen-color.png",
  gemini: "/nano-banana.png",
  seedream: "/seeddream.png",
};

export default function App() {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (
      !/^(已添加 \d+ 张参考图|图片已复制|结果已保存到历史|已保存到 .+)$/.test(
        notice,
      )
    )
      return;
    const timer = window.setTimeout(
      () => setNotice((current) => (current === notice ? "" : current)),
      4000,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [closeRequested, setCloseRequested] = useState(false);
  const requestClose = useCallback(() => setCloseRequested(true), []);
  const submitting = useRef(false);
  const ws = useWorkspace(submitting, setNotice, requestClose);
  const {
    prefs,
    setPrefs,
    draft,
    current,
    ready,
    commit,
    onChange,
    undo,
    redo,
    undoStack,
    redoStack,
  } = ws;
  const [selectedId, setSelected] = useState<string | null>(null);
  const [pStatus, setPStatus] = useState<ProviderStatus | null>(null);

  const [historyError, setHistoryError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [tab, setTab] = useState<"params" | "history">("params");
  const [settings, setSettings] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [requestFeedback, setRequestFeedback] = useState<{
    key: string;
    id: string;
  } | null>(null);
  const [refPreview, setRefPreview] = useState<string | null>(null);
  const [urlDialog, setUrlDialog] = useState(false),
    [imageUrl, setImageUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const importQueue = useRef(Promise.resolve());
  const importJobs = useRef(0);
  const [results, setResults] = useState<Partial<Record<string, SavedResult>>>(
    {},
  );
  const intent = taskIntent(draft);
  const activeKey = workspaceKey(draft);
  const result = results[activeKey] ?? null;
  const [attempts, setAttempts] = useState<
    Partial<Record<string, SavedResult[]>>
  >({});
  const [view, setView] = useState<"canvas" | "result" | "compare">("canvas");
  const [original, setOriginal] = useState(false),
    [savingResult, setSavingResult] = useState(false);
  const storeResult = (r: SavedResult) => {
    const key = workspaceKey(r.snapshot);
    setResults((s) => ({ ...s, [key]: r }));
    setAttempts((s) => ({
      ...s,
      [key]: s[key]?.some((v) => v.item.id === r.item.id)
        ? s[key]!.map((v) => (v.item.id === r.item.id ? r : v))
        : [...(s[key] ?? []), r].slice(-20),
    }));
  };
  const markSaved = (r: SavedResult) => {
    const key = workspaceKey(r.snapshot);
    setResults((s) =>
      s[key]?.item.id === r.item.id
        ? { ...s, [key]: { ...s[key]!, saved: true } }
        : s,
    );
    setAttempts((s) => ({
      ...s,
      [key]: (s[key] ?? []).map((v) =>
        v.item.id === r.item.id ? { ...v, saved: true } : v,
      ),
    }));
  };
  const refreshProviders = useCallback(async () => {
    setPStatus(await api.providerStatus());
  }, []);
  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await api.historyList());
      setHistoryError("");
    } catch (e) {
      setHistoryError("历史读取失败：" + String(e));
    }
  }, []);
  const queue = useGenerationQueue(
    submitting,
    (r) => {
      storeResult(r);
      // Queue completion never interrupts the canvas or the user's next request.
      setNotice(
        r.saved
          ? r.item.status === "partial"
            ? "批次部分完成，成功的图片已保留，可从结果栏或历史查看"
            : "任务已完成，可从结果栏或历史查看"
          : "任务已完成，历史未保存，请从结果区重新保存",
      );
    },
    refreshHistory,
    setNotice,
  );
  const generationTask = queue.task;
  const busy = !!generationTask || queue.pending.length > 0;
  useEffect(() => {
    void refreshProviders().catch((e) =>
      setNotice("无法读取提供商状态：" + String(e)),
    );
    void refreshHistory();
  }, [refreshProviders, refreshHistory]);
  useEffect(() => {
    setSelected(null);
    setView(
      intent === "create" && draft.family !== "flux" && result
        ? "result"
        : "canvas",
    );
    setRefPreview(null);
  }, [activeKey]);

  const importBatch = useCallback(
    (loaders: (() => Promise<api.ImportedImage>)[]) => {
      setImporting(true);
      importJobs.current++;
      importQueue.current = importQueue.current
        .catch(() => {})
        .then(async () => {
          const accepted: WorkingImage[] = [],
            errors: string[] = [];
          for (const load of loaders) {
            const max = routeFor(current.current)?.maxRefs ?? 0;
            if (current.current.refs.length + accepted.length >= max) {
              errors.push(`此路由参考图最多 ${max} 张，其余文件未导入`);
              break;
            }
            try {
              const r = await load();
              if (r.width * r.height > 16_000_000)
                throw new Error(r.name + " 超过 16MP");
              accepted.push({ ...r, uid: crypto.randomUUID() });
            } catch (e) {
              errors.push(String(e));
            }
          }
          if (accepted.length) {
            const room = Math.max(
              0,
              (routeFor(current.current)?.maxRefs ?? 0) -
                current.current.refs.length,
            );
            if (accepted.length > room)
              errors.push("导入期间方案变化，超过上限的文件未导入");
            const next = {
              ...current.current,
              refs: [...current.current.refs, ...accepted.slice(0, room)],
            };
            commit(
              taskIntent(next) === "edit" && !next.baseId && next.refs.length
                ? setPrimaryImage(next, next.refs[0].uid!)
                : next,
              true,
            );
          }
          setNotice(
            [
              accepted.length ? "已添加 " + accepted.length + " 张参考图" : "",
              ...errors,
            ]
              .filter(Boolean)
              .join("；"),
          );
        })
        .catch((e) => setNotice("导入失败：" + String(e)))
        .finally(() => {
          importJobs.current--;
          if (!importJobs.current) setImporting(false);
        });
    },
    [commit, current],
  );
  const openFiles = async () => {
    try {
      const paths = await open({
        multiple: true,
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        ],
      });
      if (paths)
        importBatch(
          (Array.isArray(paths) ? paths : [paths]).map(
            (path) => () => api.importImage(path),
          ),
        );
    } catch (e) {
      setNotice(String(e));
    }
  };
  const importMask = async () => {
    const snapshot = current.current;
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "透明 PNG 蒙版", extensions: ["png"] }],
      });
      if (!path) return;
      const mask = await api.importImage(Array.isArray(path) ? path[0] : path);
      if (
        current.current.family !== snapshot.family ||
        current.current.refs[0]?.uid !== snapshot.refs[0]?.uid
      )
        throw new Error("导入期间编辑主图已改变，请重新导入蒙版");
      commit(
        {
          ...current.current,
          mask: { ...mask, uid: crypto.randomUUID() },
          maskRects: [],
        },
        true,
      );
    } catch (e) {
      setNotice("蒙版导入失败：" + String(e));
    }
  };
  useEffect(() => {
    if (!api.isDesktop()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "drop")
          importBatch(
            e.payload.paths.map((path) => () => api.importImage(path)),
          );
      })
      .then((fn) => {
        if (disposed) fn();
        else off = fn;
      })
      .catch((e) => setNotice("拖放初始化失败：" + String(e)));
    return () => {
      disposed = true;
      off?.();
    };
  }, [importBatch]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!ready || settings || refPreview || urlDialog) return;
      const typing =
        e.target instanceof HTMLElement &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) ||
          e.target.isContentEditable);
      if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        setSelected(null);
      }
      if (!typing && e.ctrlKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        setSelected(null);
      }
      if (!typing && e.ctrlKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        importBatch([api.clipboardImage]);
      }
      if (!typing && ["Delete", "Backspace"].includes(e.key) && selectedId) {
        e.preventDefault();
        const d = current.current;
        if (d.family === "gpt" && d.refs[0]) {
          const rects = (d.maskRects ?? []).filter(
            (_, i) => "编辑区_" + (i + 1) !== selectedId,
          );
          commit(
            {
              ...d,
              maskRects: rects,
              mask: rects.length ? maskFromRects(d.refs[0], rects) : null,
            },
            true,
          );
        } else if (d.family === "flux")
          commit(
            { ...d, boxes: d.boxes.filter((b) => b.id !== selectedId) },
            true,
          );
        setSelected(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const requestDraft = singleImageDraft(draft);
  const preview = compileDraft(requestDraft);
  const errors = [
    ...validateDraft(requestDraft),
    ...(draft.prompt.trim() || draft.boxes.length
      ? preview.error
        ? [preview.error]
        : []
      : []),
  ];
  const retryHistory = async (r: SavedResult) => {
    setSavingResult(true);
    try {
      await api.historySave(r.item, r.files);
      markSaved(r);
      await refreshHistory();
      setNotice("结果已保存到历史");
    } catch (e) {
      setNotice("历史保存失败，可再次保存：" + String(e));
    } finally {
      setSavingResult(false);
    }
  };
  const generate = async (count: number) => {
    if (!ready || importing) return;
    const snapshot = singleImageDraft(current.current);
    const compiled = compileDraft(snapshot);
    const invalid = [
      ...validateDraft(snapshot),
      ...(compiled.error ? [compiled.error] : []),
    ];
    if (invalid.length) {
      setNotice(invalid.join("；"));
      return;
    }
    try {
      await ws.persist(snapshot);
      const id = await queue.enqueue(snapshot, count);
      if (!id) return;
      setRequestFeedback({ key: workspaceKey(snapshot), id });
      setNotice("已加入任务队列，可以继续创建下一条请求");
    } catch (e) {
      setNotice("加入队列失败：" + String(e));
    }
  };
  const useResult = (im: WorkingImage, edit: boolean) => {
    const d = edit ? ws.draftForIntent("edit") : current.current,
      max = routeFor(d)?.maxRefs ?? 0;
    if (!edit && d.refs.length >= max) {
      setNotice(`参考图已达 ${max} 张，请先移除一张`);
      return;
    }
    const r = { ...im, uid: crypto.randomUUID() };
    const retained =
      taskIntent(d) === "edit"
        ? d.refs.filter((ref) => ref.uid !== (d.baseId ?? d.refs[0]?.uid))
        : d.refs;
    if (edit && retained.length + 1 > max) {
      setNotice(`保留参考素材后超过 ${max} 张，请先移除一张素材再继续编辑`);
      return;
    }
    commit(
      edit
        ? {
            ...d,
            refs: [r, ...retained],
            prompt: "",
            baseId: r.uid,
            intent: "edit",
            showBase: true,
            boxes: [],
            mask: null,
            maskRects: [],
            canvas: { w: im.width, h: im.height },
            params: {
              ...d.params,
              ...(d.family === "flux" ? { aspectRatio: "auto" } : {}),
            },
          }
        : { ...d, refs: [...d.refs, r] },
      true,
    );
    setView("canvas");
    setTab("params");
    setSelected(null);
  };
  const restoreHistory = async (item: HistoryItem) => {
    if (importing) {
      setNotice("请等待图片导入完成后恢复历史");
      return;
    }
    try {
      const refs = await Promise.all(
        item.inputFiles.map(async (path, i) => ({
          ...(await api.importImage(path)),
          name: item.recipe?.refNames[i] ?? "参考图 " + (i + 1),
          uid: item.recipe?.refIds[i] ?? crypto.randomUUID(),
          purpose: item.recipe?.refPurposes?.[i],
          note: item.recipe?.refNotes?.[i],
        })),
      );
      const mask = item.maskFile
        ? {
            ...(await api.importImage(item.maskFile)),
            name: item.recipe?.maskName ?? "编辑蒙版",
          }
        : null;
      const inferred = modelByAnyId(item.model) ?? undefined;
      const legacy = newDraft(prefs, inferred?.family ?? "flux");
      const raw = item.recipe
        ? { ...item.recipe, refs, mask }
        : {
            ...legacy,
            refs,
            mask,
            prompt: item.prompt,
            boxes: item.boxes.map((b) => ({ ...b, sourceId: refs[0]?.uid })),
            provider: item.provider,
            params: { ...legacy.params, ...item.params },
            canvas: {
              w: item.canvasWidth ?? 1024,
              h: item.canvasHeight ?? 1024,
            },
            baseId: refs[0]?.uid ?? null,
          };
      commit(withIds(migrateDraft(raw)), true);
      setView("canvas");
      setTab("params");
      setSelected(null);
    } catch (e) {
      setNotice("方案恢复失败，当前工作未改变：" + String(e));
    }
  };
  const historyAsInput = async (item: HistoryItem) => {
    try {
      if (!item.resultFiles[0]) throw new Error("记录没有结果图片");
      useResult(await api.importImage(item.resultFiles[0]), true);
    } catch (e) {
      setNotice(String(e));
    }
  };
  const chooseResult = async (index: number) => {
    if (!result) return;
    try {
      const im = result.out.images[index];
      storeResult({
        ...result,
        selectedIndex: index,
        image: {
          uid: crypto.randomUUID(),
          dataUrl: im.dataUrl,
          ...(await imageSize(im.dataUrl)),
          name: "生成结果 " + (index + 1),
        },
      });
      setView("result");
    } catch (e) {
      setNotice("结果读取失败：" + String(e));
    }
  };
  const saveResult = async () => {
    if (!result) return;
    try {
      const mime = result.out.images[result.selectedIndex].mediaType,
        ext = mime.includes("jpeg")
          ? "jpg"
          : mime.includes("webp")
            ? "webp"
            : "png";
      const path = await save({
        defaultPath: exportDefaultPath(
          prefs.saveDirectory,
          "lutriui-" +
            result.item.id.slice(0, 8) +
            (result.selectedIndex ? "-" + (result.selectedIndex + 1) : "") +
            "." +
            ext,
        ),
        filters: [{ name: "图片", extensions: [ext] }],
      });
      if (path) {
        await api.saveDataUrl(result.image.dataUrl, path);
        setNotice("已保存到 " + path);
      }
    } catch (e) {
      setNotice("另存为失败：" + String(e));
    }
  };
  const changeBoxes = (boxes: Box[]) =>
    commit(updateFluxBoxes(current.current, boxes));
  const reference = draft.refs.find((r) => r.uid === refPreview);
  const resultBase = getResultBase(result);
  const references = (
    <References
      draft={draft}
      ready={ready}
      importing={importing}
      onChange={(d, discrete = true) => commit(d, discrete)}
      onPreview={setRefPreview}
      onFiles={() => void openFiles()}
      onPaste={() => importBatch([api.clipboardImage])}
      onUrl={() => setUrlDialog(true)}
      onNotice={setNotice}
    />
  );
  return (
    <div className={"workbench workbench-" + draft.family}>
      <header className="app-header">
        <div className="header-identity">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <strong>LutriUI</strong>
          </div>
          <div className="task-tabs segmented" aria-label="创作任务">
            {(["create", "edit"] as const).map((task) => (
              <button
                key={task}
                aria-pressed={intent === task}
                className={intent === task ? "active" : ""}
                disabled={!ready || importing}
                onClick={() => ws.switchIntent(task)}
              >
                {task === "create" ? "生成" : "编辑"}
              </button>
            ))}
          </div>
        </div>
        <div className="family-tabs" role="tablist" aria-label="模型家族">
          {families.map((f) => (
            <button
              role="tab"
              aria-selected={draft.family === f.id}
              className={draft.family === f.id ? "active" : ""}
              key={f.id}
              title={f.description}
              disabled={!ready || importing}
              onClick={() => {
                ws.switchFamily(f.id);
                setTab("params");
              }}
            >
              <img
                className={
                  "family-icon" + (["flux", "gpt"].includes(f.id) ? " monochrome" : "")
                }
                src={FAMILY_ICONS[f.id]}
                width={20}
                height={20}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              {f.label}
            </button>
          ))}
        </div>
        <div className="row">
          {(generationTask || queue.pending.length > 0) && (
            <button onClick={() => setQueueOpen(true)}>
              任务队列 · {queue.pending.length + (generationTask ? 1 : 0)}
            </button>
          )}
          {generationTask && tab === "history" && (
            <button
              onClick={() => {
                ws.switchWorkspace(
                  generationTask.family,
                  generationTask.intent ?? "create",
                );
                setTab("params");
              }}
            >
              <span className="activity-dot" aria-hidden="true" />
              查看任务
            </button>
          )}
          <button
            disabled={!ready || importing}
            onClick={() => {
              ws.reset();
              setSelected(null);
              setView("canvas");
            }}
          >
            <Plus size={15} />
            新建
          </button>
          <button
            disabled={!undoStack.length || importing}
            onClick={() => {
              undo();
              setSelected(null);
            }}
            title="撤销 Ctrl+Z"
          >
            <ArrowCounterClockwise size={16} />
          </button>
          <button
            disabled={!redoStack.length || importing}
            onClick={() => {
              redo();
              setSelected(null);
            }}
            title="重做 Ctrl+Shift+Z"
          >
            <ArrowClockwise size={16} />
          </button>
          <button onClick={() => setSettings(true)}>
            <GearSix size={16} />
            设置
          </button>
        </div>
      </header>
      <div className="workspace">
        <ResizableSidebar
          widthPercent={prefs.sidebarWidthPercent}
          onWidthChange={(sidebarWidthPercent) =>
            setPrefs((p) => ({ ...p, sidebarWidthPercent }))
          }
        >
          <div className="tabs">
            <button
              className={tab === "params" ? "active" : ""}
              onClick={() => setTab("params")}
            >
              方案
            </button>
            <button
              className={tab === "history" ? "active" : ""}
              onClick={() => setTab("history")}
            >
              历史
            </button>
          </div>
          {tab === "params" ? (
            <WorkspaceSidebar
              draft={draft}
              onChange={onChange}
              onReorder={(boxes) => commit({ ...current.current, boxes }, true)}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelected(id);
                setView("canvas");
              }}
              onRename={(uid, id) => {
                commit(renameBox(current.current, uid, id), true);
                setSelected(id);
              }}
              providerStatus={pStatus}
              busy={queue.accepting || !queue.ready || !ready || importing}
              generationTask={generationTask}
              queueCount={queue.pending.length}
              sentRequestId={
                requestFeedback?.key === activeKey
                  ? requestFeedback.id
                  : undefined
              }
              onShowTask={() =>
                generationTask &&
                ws.switchWorkspace(
                  generationTask.family,
                  generationTask.intent ?? "create",
                )
              }
              finalPreview={preview.finalPrompt}
              errors={errors}
              onGenerate={(count) => void generate(count)}
              onSettings={() => setSettings(true)}
            />
          ) : (
            <>
              {historyError && (
                <div className="history-error">
                  {historyError}
                  <button onClick={() => void refreshHistory()}>重试</button>
                </div>
              )}
              <HistoryPanel
                saveDirectory={prefs.saveDirectory}
                items={history}
                onCancel={(id) => void queue.cancel(id)}
                onRefresh={() => void refreshHistory()}
                onUseAsInput={(item) => void historyAsInput(item)}
                onRestoreEdit={(item) => void restoreHistory(item)}
              />
            </>
          )}
        </ResizableSidebar>
        <main
          className="main-area"
          aria-label={familyById(draft.family).label + " 工作区"}
        >
          <div className="canvas-toolbar">
            <div className="row">
              <strong>
                {intent === "create"
                  ? draft.family === "flux" && view === "canvas"
                    ? "构图"
                    : "生成预览"
                  : "编辑图片"}
              </strong>
              {intent === "create" && draft.family === "flux" && result && (
                <button
                  onClick={() =>
                    setView(view === "canvas" ? "result" : "canvas")
                  }
                >
                  {view === "canvas" ? "查看生成结果" : "返回构图"}
                </button>
              )}
              {intent === "edit" && result && (
                <>
                  <button
                    className={view === "canvas" ? "active" : ""}
                    onClick={() => setView("canvas")}
                  >
                    原图
                  </button>
                  <button
                    className={view === "result" ? "active" : ""}
                    onClick={() => setView("result")}
                  >
                    编辑结果
                  </button>
                  {resultBase && (
                    <button
                      className={view === "compare" ? "active" : ""}
                      onClick={() => setView("compare")}
                    >
                      对照
                    </button>
                  )}
                </>
              )}
            </div>
            {view === "canvas" &&
            draft.family === "flux" &&
            intent === "create" ? (
              <span className="muted">
                {draft.canvas.w}×{draft.canvas.h}
              </span>
            ) : result && view !== "canvas" ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={original}
                  onChange={(e) => setOriginal(e.target.checked)}
                />
                查看原尺寸
              </label>
            ) : null}
          </div>
          {view === "canvas" &&
          ((intent === "edit" && !primaryImage(draft)) ||
            (intent === "create" && draft.family !== "flux")) ? (
            <div className="result-work-area">
              <div className="stage workspace-empty">
                <strong>
                  {intent === "edit"
                    ? "添加要编辑的图片"
                    : "描述你想生成的画面"}
                </strong>
                <p className="muted">
                  {intent === "edit"
                    ? "先指定编辑主图，再描述修改内容；参考图可以随后添加。"
                    : "填写提示词并生成，结果会显示在这里。参考图可选。"}
                </p>
                {intent === "edit" && (
                  <button disabled={importing} onClick={() => void openFiles()}>
                    添加编辑主图
                  </button>
                )}
                {intent === "create" && result && (
                  <button onClick={() => setView("result")}>
                    查看生成结果
                  </button>
                )}
              </div>
              {references}
            </div>
          ) : view === "canvas" ? (
            <WorkspaceStage
              draft={draft}
              references={references}
              selectedId={selectedId}
              onSelect={setSelected}
              onChange={onChange}
              onBoxesChange={changeBoxes}
              onGestureStart={ws.beginGesture}
              onGestureEnd={ws.endGesture}
              onImportMask={() => void importMask()}
            />
          ) : (
            <div className="result-work-area">
              <ResultStage result={result} view={view} original={original} />
              {references}
            </div>
          )}
          {result && (
            <ResultActions
              result={result}
              attempts={attempts[activeKey] ?? []}
              onAttempt={(r) => {
                setResults((s) => ({ ...s, [activeKey]: r }));
                setView("result");
              }}
              saving={savingResult}
              onSelect={(i) => void chooseResult(i)}
              onSave={() => void saveResult()}
              onCopy={() =>
                void api
                  .copyImage(result.image.dataUrl)
                  .then(() => setNotice("图片已复制"))
                  .catch((e) => setNotice(String(e)))
              }
              onUse={useResult}
              onRetry={() => void retryHistory(result)}
            />
          )}
        </main>
      </div>
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice("")} aria-label="关闭通知">
            ×
          </button>
        </div>
      )}
      {queueOpen && (
        <Modal title="任务队列" onClose={() => setQueueOpen(false)}>
          <p className="help">
            任务按提交顺序执行；可以继续准备和提交下一条请求。
          </p>
          {generationTask && (
            <div className="queue-item">
              <strong>
                执行中 · {familyById(generationTask.family).label}
              </strong>
              <button
                onClick={() => {
                  ws.switchWorkspace(
                    generationTask.family,
                    generationTask.intent ?? "create",
                  );
                  setQueueOpen(false);
                }}
              >
                查看工作区
              </button>
            </div>
          )}
          {queue.pending.map((item, i) => (
            <div className="queue-item" key={item.id}>
              <div>
                <strong>等待执行 · {i + 1}</strong>
                <p>{item.prompt}</p>
              </div>
              <button onClick={() => void queue.cancel(item.id)}>
                取消等待
              </button>
            </div>
          ))}
          {!generationTask && !queue.pending.length && (
            <p>队列已完成，结果保存在历史中。</p>
          )}
        </Modal>
      )}
      {settings && (
        <Settings
          prefs={prefs}
          initialProvider={draft.provider}
          onChange={setPrefs}
          status={pStatus}
          refresh={refreshProviders}
          onHistory={() => {
            setSettings(false);
            setTab("history");
          }}
          onClose={() => setSettings(false)}
        />
      )}
      {closeRequested && (
        <Modal title="关闭应用" onClose={() => setCloseRequested(false)}>
          <p>
            {busy
              ? "生成任务尚未结束。关闭后远程任务可能继续计费，尚未下载的结果可能无法恢复。"
              : "任务已结束。请确认需要保留的结果已保存。"}
          </p>
          <div className="row close-actions">
            <button
              className="primary"
              onClick={() => setCloseRequested(false)}
            >
              {busy ? "继续等待" : "返回应用"}
            </button>
            <button onClick={() => void ws.closeApp()}>仍然关闭</button>
          </div>
        </Modal>
      )}
      {reference && (
        <Modal
          title={"参考图 · " + reference.name}
          large
          onClose={() => setRefPreview(null)}
        >
          <div className="image-preview">
            <img src={reference.dataUrl} alt={reference.name} />
          </div>
          <p className="help">
            {reference.width}×{reference.height} px
          </p>
        </Modal>
      )}
      {urlDialog && (
        <Modal title="从 URL 添加参考图" onClose={() => setUrlDialog(false)}>
          <label>
            图片地址
            <input
              type="url"
              placeholder="https://…"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
            />
          </label>
          <p className="help">
            下载并保存本地副本，后续恢复不依赖原链接。仅支持 http/https 图片。
          </p>
          <button
            className="primary"
            disabled={!imageUrl.trim()}
            onClick={() => {
              const url = imageUrl.trim();
              importBatch([() => api.importUrl(url)]);
              setUrlDialog(false);
              setImageUrl("");
            }}
          >
            添加参考图
          </button>
        </Modal>
      )}
    </div>
  );
}
