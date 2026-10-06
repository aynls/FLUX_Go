import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  GearSix,
  Plus,
  FrameCorners,
  Hand,
} from "@phosphor-icons/react";
import Canvas from "./components/Canvas";
import ResizableSidebar from "./components/ResizableSidebar";
import HistoryPanel from "./components/HistoryPanel";
import Settings from "./components/Settings";
import Modal from "./components/Modal";
import References from "./workspaces/shared/References";
import { WorkspaceSidebar, WorkspaceStage } from "./workspaces";
import { useWorkspace } from "./app/useWorkspace";
import * as api from "./lib/api";
import { imageSize, makeThumb } from "./lib/image";
import { exportDefaultPath } from "./lib/export";
import {
  newDraft,
  renameBox,
  withIds,
  validateDraft,
  migrateDraft,
  taskIntent,
  setPrimaryImage,
} from "./lib/workspace";
import { families, familyById, modelByAnyId, routeFor } from "./models/catalog";
import { compileDraft } from "./models";
import { maskFromRects } from "./workspaces/gpt/mask";
import type {
  Box,
  FamilyId,
  HistoryItem,
  ProviderStatus,
  WorkingImage,
  GenerationTask,
} from "./lib/types";

import {
  executeGeneration,
  getResultBase,
  type SavedResult,
} from "./app/generation";
import { ResultStage, ResultActions } from "./components/Results";
import { updateFluxBoxes } from "./models/flux/regions";

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
  const [generationTask, setGenerationTask] = useState<GenerationTask | null>(
    null,
  );
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
  const [tool, setTool] = useState<"box" | "pan">("box");
  const [pStatus, setPStatus] = useState<ProviderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [tab, setTab] = useState<"params" | "history">("params");
  const [settings, setSettings] = useState(false);
  const [refPreview, setRefPreview] = useState<string | null>(null);
  const [sourceBox, setSourceBox] = useState<string | null>(null);
  const [urlDialog, setUrlDialog] = useState(false),
    [imageUrl, setImageUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const importQueue = useRef(Promise.resolve());
  const importJobs = useRef(0);
  const [results, setResults] = useState<
    Partial<Record<FamilyId, SavedResult>>
  >({});
  const result = results[draft.family] ?? null;
  const [view, setView] = useState<"canvas" | "result" | "compare">("canvas");
  const [original, setOriginal] = useState(false),
    [savingResult, setSavingResult] = useState(false);
  const storeResult = (r: SavedResult) =>
    setResults((s) => ({ ...s, [r.snapshot.family]: r }));
  const markSaved = (r: SavedResult) =>
    setResults((s) => ({
      ...s,
      [r.snapshot.family]:
        s[r.snapshot.family]?.item.id === r.item.id
          ? { ...s[r.snapshot.family]!, saved: true }
          : { ...r, saved: true },
    }));
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
  useEffect(() => {
    void refreshProviders().catch((e) =>
      setNotice("无法读取提供商状态：" + String(e)),
    );
    void refreshHistory();
  }, [refreshProviders, refreshHistory]);
  useEffect(() => {
    setSelected(null);
    setView("canvas");
    setRefPreview(null);
    setSourceBox(null);
  }, [draft.family]);

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
      if (!ready || settings || refPreview || sourceBox || urlDialog) return;
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

  const preview = compileDraft(draft);
  const errors = [
    ...validateDraft(draft),
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
  const generate = async () => {
    if (submitting.current || !ready || importing) return;
    const snapshot = current.current,
      compiled = compileDraft(snapshot);
    const invalid = [
      ...validateDraft(snapshot),
      ...(compiled.error ? [compiled.error] : []),
    ];
    if (invalid.length) {
      setNotice(invalid.join("；"));
      return;
    }
    submitting.current = true;
    setBusy(true);
    setGenerationTask({
      family: snapshot.family,
      modelId: snapshot.modelId,
      provider: snapshot.provider,
      startedAt: Date.now(),
      total: routeFor(snapshot)?.parameters.count
        ? (snapshot.params.count ?? 1)
        : 1,
      phase: "preparing",
    });
    try {
      await ws.persist(snapshot);
      const r = await executeGeneration(snapshot, (progress) =>
        setGenerationTask((task) => (task ? { ...task, ...progress } : null)),
      );
      const { item, files } = r;
      storeResult(r);
      if (current.current.family === snapshot.family) {
        setView("result");
        setOriginal(false);
      }
      try {
        setGenerationTask((task) =>
          task ? { ...task, phase: "saving" } : null,
        );
        item.thumb = await makeThumb(r.image.dataUrl);
        await api.historySave(item, files);
        markSaved(r);
        await refreshHistory();
      } catch (e) {
        setNotice(
          "生成成功，但历史未保存：" +
            String(e) +
            "。请使用结果区的「重新保存历史」。",
        );
      }
    } catch (e) {
      setNotice(
        "生成失败：" +
          (e instanceof Error ? e.message : String(e)) +
          (e instanceof api.AppError && e.hint ? " · " + e.hint : ""),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
      setGenerationTask(null);
    }
  };
  const useResult = (im: WorkingImage, edit: boolean) => {
    const d = current.current,
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
          "flux-" +
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
  const reference = draft.refs.find((r) => r.uid === refPreview),
    editingBox = draft.boxes.find((b) => b.uid === sourceBox),
    source = draft.refs.find((r) => r.uid === editingBox?.sourceId);
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
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <strong>FLUX_Go</strong>
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
              {f.label}
            </button>
          ))}
        </div>
        <div className="row">
          {generationTask && tab === "history" && (
            <button
              onClick={() => {
                ws.switchFamily(generationTask.family);
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
              onSource={(b) => setSourceBox(b.uid!)}
              providerStatus={pStatus}
              busy={busy || !ready || importing}
              generationTask={generationTask}
              onShowTask={() =>
                generationTask && ws.switchFamily(generationTask.family)
              }
              finalPreview={preview.finalPrompt}
              errors={errors}
              onGenerate={() => void generate()}
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
              <button
                className={view === "canvas" ? "active" : ""}
                onClick={() => setView("canvas")}
              >
                {draft.family === "flux" ? "输出画布" : "创作工作区"}
              </button>
              <button
                disabled={!result}
                className={view === "result" ? "active" : ""}
                onClick={() => setView("result")}
              >
                生成结果
              </button>
              <button
                disabled={!result || !resultBase}
                className={view === "compare" ? "active" : ""}
                onClick={() => setView("compare")}
              >
                原图 / 结果对照
              </button>
            </div>
            {view === "canvas" && draft.family === "flux" ? (
              <div className="row">
                <button
                  className={tool === "box" ? "active" : ""}
                  onClick={() => setTool("box")}
                >
                  <FrameCorners size={16} />
                  画框
                </button>
                <button
                  className={tool === "pan" ? "active" : ""}
                  onClick={() => setTool("pan")}
                >
                  <Hand size={16} />
                  平移
                </button>
                <span className="muted">
                  构图 {draft.canvas.w}×{draft.canvas.h}
                </span>
              </div>
            ) : (
              view !== "canvas" && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={original}
                    onChange={(e) => setOriginal(e.target.checked)}
                  />
                  查看原尺寸
                </label>
              )
            )}
          </div>
          {view === "canvas" ? (
            <WorkspaceStage
              draft={draft}
              references={references}
              tool={tool}
              selectedId={selectedId}
              onSelect={setSelected}
              onChange={onChange}
              onBoxesChange={changeBoxes}
              onGestureStart={ws.beginGesture}
              onGestureEnd={ws.endGesture}
              onImportMask={() => void importMask()}
              onSource={(b) => setSourceBox(b.uid!)}
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
      {editingBox && source && (
        <Modal
          title={"编辑源区域 · " + editingBox.id + " · " + source.name}
          large
          onClose={() => setSourceBox(null)}
        >
          <p className="help">拖拽画选替换源区域，或拖动 / 缩放当前框</p>
          <div className="source-editor">
            <Canvas
              image={source}
              phantom={null}
              boxes={
                editingBox.srcRect
                  ? [
                      {
                        ...editingBox,
                        rect: editingBox.srcRect,
                        srcRect: undefined,
                      },
                    ]
                  : []
              }
              selectedId={editingBox.id}
              tool="box"
              onSelect={() => {}}
              onGestureStart={ws.beginGesture}
              onGestureEnd={ws.endGesture}
              onCreateRect={(rect) =>
                commit({
                  ...current.current,
                  boxes: current.current.boxes.map((b) =>
                    b.uid === editingBox.uid ? { ...b, srcRect: rect } : b,
                  ),
                })
              }
              onChange={(boxes) => {
                if (boxes[0])
                  commit({
                    ...current.current,
                    boxes: current.current.boxes.map((b) =>
                      b.uid === editingBox.uid
                        ? { ...b, srcRect: boxes[0].rect }
                        : b,
                    ),
                  });
              }}
            />
          </div>
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
