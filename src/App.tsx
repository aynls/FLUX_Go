import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowCounterClockwise, ArrowClockwise, GearSix, Plus, FrameCorners, Hand } from "@phosphor-icons/react";
import Canvas from "./components/Canvas";
import Sidebar from "./components/Sidebar";
import ResizableSidebar from "./components/ResizableSidebar";
import HistoryPanel from "./components/HistoryPanel";
import Settings from "./components/Settings";
import Modal from "./components/Modal";
import * as api from "./lib/api";
import { downscaleDataUrl, imageSize, makeThumb } from "./lib/image";
import { exportDefaultPath } from "./lib/export";
import { DEFAULT_PARAMS, phantomSize } from "./lib/params";
import { composePrompt, MODEL_FLUX3 } from "./lib/protocol";
import { DEFAULT_PREFERENCES, newDraft, reorderRefs, resizeCanvas, renameBox, withIds, validateDraft, scaleRect } from "./lib/workspace";
import type { Draft, HistoryItem, Preferences, ProviderStatus, WorkingImage } from "./lib/types";

type SavedResult = { image: WorkingImage; out: import("./lib/types").GenerateOutput; snapshot: Draft; item: HistoryItem; files: { kind: string; name: string; data: string }[]; saved: boolean };
function readPreferences(): Preferences {
  try { const p = JSON.parse(localStorage.getItem("flux-preferences-v2") ?? "null"); return p ? { ...DEFAULT_PREFERENCES, ...p, params: { ...DEFAULT_PARAMS, ...p.params } } : DEFAULT_PREFERENCES; }
  catch { return DEFAULT_PREFERENCES; }
}

export default function App() {
  const [prefs, setPrefs] = useState<Preferences>(readPreferences);
  const [draft, setDraft] = useState<Draft>(() => newDraft(prefs));
  const current = useRef(draft);
  const [ready, setReady] = useState(false);
  const saveAllowed = useRef(true);
  const [undoStack, setUndo] = useState<Draft[]>([]);
  const [redoStack, setRedo] = useState<Draft[]>([]);
  const gesture = useRef(false);
  const lastEdit = useRef(0);
  const [selectedId, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<"box" | "pan">("box");
  const [pStatus, setPStatus] = useState<ProviderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [notice, setNotice] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [tab, setTab] = useState<"params" | "history">("params");
  const [settings, setSettings] = useState(false);
  const [refPreview, setRefPreview] = useState<string | null>(null);
  const [sourceBox, setSourceBox] = useState<string | null>(null);
  const [urlDialog, setUrlDialog] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const importQueue = useRef(Promise.resolve());
  const [result, setResult] = useState<SavedResult | null>(null);
  const [view, setView] = useState<"canvas" | "result" | "compare">("canvas");
  const [original, setOriginal] = useState(false);
  const [savingResult, setSavingResult] = useState(false);

  const replace = useCallback((d: Draft) => { current.current = d; setDraft(d); }, []);
  const commit = useCallback((d: Draft, discrete = false) => {
    if (!gesture.current && (discrete || Date.now() - lastEdit.current > 600)) setUndo(s => [...s.slice(-39), current.current]);
    lastEdit.current = Date.now(); setRedo([]); replace(withIds(d));
  }, [replace]);
  const undo = () => { const prior = undoStack.at(-1); if (!prior) return; setRedo(s => [...s, current.current]); setUndo(s => s.slice(0, -1)); replace(prior); setSelected(null); lastEdit.current = 0; };
  const redo = () => { const next = redoStack.at(-1); if (!next) return; setUndo(s => [...s, current.current]); setRedo(s => s.slice(0, -1)); replace(next); setSelected(null); lastEdit.current = 0; };
  const onChange = (next: Draft) => {
    let d = next;
    if (next.params.aspectRatio !== current.current.params.aspectRatio && next.params.aspectRatio !== "auto") d = resizeCanvas(next, phantomSize(next.params.aspectRatio));
    commit(d);
  };
  const refreshProviders = useCallback(async () => { setPStatus(await api.providerStatus()); }, []);
  const refreshHistory = useCallback(async () => { try { setHistory(await api.historyList()); setHistoryError(""); } catch (e) { setHistoryError("历史读取失败：" + String(e)); } }, []);
  useEffect(() => {
    let alive = true;
    void refreshProviders().catch(e => setNotice("无法读取提供商状态：" + String(e)));
    void refreshHistory();
    api.draftLoad().then(d => { if (!alive) return; if (d?.schema === 2 && Array.isArray(d.refs) && Array.isArray(d.boxes) && d.canvas?.w > 0 && d.canvas?.h > 0 && d.params && typeof d.prompt === "string") { replace(withIds(d)); setNotice("已恢复上次方案"); } else if (d) { saveAllowed.current = false; setNotice("草稿版本或内容不兼容，已暂停保存以保留原文件。新建方案后可重新保存。"); } }).catch(e => { saveAllowed.current = false; setNotice("草稿恢复失败，已暂停保存以保留原文件：" + String(e)); }).finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [refreshProviders, refreshHistory, replace]);
  const saveQueue = useRef(Promise.resolve());
  useEffect(() => {
    if (!ready || !saveAllowed.current) return;
    const timer = window.setTimeout(() => {
      saveQueue.current = saveQueue.current.catch(() => {}).then(() => api.draftSave(draft)).catch(e => setNotice("草稿保存失败：" + String(e)));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [draft, ready]);
  useEffect(() => {
    let disposed = false; let off: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(async event => {
      event.preventDefault();
      if (submitting.current) { setNotice("生成任务进行中，请等结果返回并保存后关闭"); return; }
      try { await saveQueue.current.catch(() => {}); if (saveAllowed.current) await api.draftSave(current.current); await getCurrentWindow().destroy(); }
      catch (e) { setNotice("关闭前保存失败：" + String(e) + "。请修复后再关闭。"); }
    }).then(fn => { if (disposed) fn(); else off = fn; }).catch(e => setNotice("关闭保护初始化失败：" + String(e)));
    return () => { disposed = true; off?.(); };
  }, []);
  useEffect(() => {
    try { localStorage.setItem("flux-preferences-v2", JSON.stringify(prefs)); } catch (e) { setNotice("偏好保存失败：" + String(e)); }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => { document.documentElement.dataset.theme = prefs.theme === "system" ? (media.matches ? "dark" : "light") : prefs.theme; };
    update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, [prefs]);

  const importBatch = useCallback((loaders: (() => Promise<api.ImportedImage>)[]) => {
    importQueue.current = importQueue.current.catch(() => {}).then(async () => {
      setImporting(true);
      const accepted: WorkingImage[] = []; const errors: string[] = [];
      for (const load of loaders) {
        if (current.current.refs.length + accepted.length >= 10) { errors.push("参考图最多 10 张，其余文件未导入"); break; }
        try { const r = await load(); if (r.width * r.height > 16_000_000) throw new Error(r.name + " 超过 16MP"); accepted.push({ ...r, uid: crypto.randomUUID() }); }
        catch (e) { errors.push(String(e)); }
      }
      if (accepted.length) {
        const room = 10 - current.current.refs.length;
        if (accepted.length > room) errors.push("导入期间参考图变化，超过上限的文件未导入");
        commit({ ...current.current, refs: [...current.current.refs, ...accepted.slice(0, room)] }, true);
      }
      setNotice([accepted.length ? "已添加 " + accepted.length + " 张参考图" : "", ...errors].filter(Boolean).join("；")); setImporting(false);
    });
  }, [commit]);
  const openFiles = async () => {
    try { const paths = await open({ multiple: true, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
      if (paths) importBatch((Array.isArray(paths) ? paths : [paths]).map(path => () => api.importImage(path)));
    } catch (e) { setNotice(String(e)); }
  };
  useEffect(() => {
    let disposed = false; let off: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent(e => { if (e.payload.type === "drop") importBatch(e.payload.paths.map(path => () => api.importImage(path))); }).then(fn => { if (disposed) fn(); else off = fn; }).catch(e => setNotice("拖放初始化失败：" + String(e)));
    return () => { disposed = true; off?.(); };
  }, [importBatch]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (settings || refPreview || sourceBox || urlDialog) return;
      const typing = e.target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable);
      if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if (!typing && e.ctrlKey && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      if (!typing && e.ctrlKey && e.key.toLowerCase() === "v") { e.preventDefault(); importBatch([api.clipboardImage]); }
      if (!typing && (e.key === "Delete" || e.key === "Backspace") && selectedId) { e.preventDefault(); commit({ ...current.current, boxes: current.current.boxes.filter(b => b.id !== selectedId) }, true); setSelected(null); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  });

  const mode = draft.refs.length ? "edit" : "t2i";
  const preview = composePrompt({ mode, instruction: draft.prompt, boxes: draft.boxes, iw: draft.canvas.w, ih: draft.canvas.h, refs: draft.refs });
  const errors = [...validateDraft(draft), ...(draft.prompt.trim() || draft.boxes.length ? preview.error ? [preview.error] : [] : [])];
  const retryHistory = async (r: SavedResult) => {
    setSavingResult(true);
    try { await api.historySave(r.item, r.files); setResult(x => x?.item.id === r.item.id ? { ...x, saved: true } : x); await refreshHistory(); setNotice("结果已保存到历史"); }
    catch (e) { setNotice("历史保存失败，可再次保存：" + String(e)); }
    finally { setSavingResult(false); }
  };
  const generate = async () => {
    if (submitting.current || !ready) return;
    const snapshot = current.current;
    const compiled = composePrompt({ mode: snapshot.refs.length ? "edit" : "t2i", instruction: snapshot.prompt, boxes: snapshot.boxes, iw: snapshot.canvas.w, ih: snapshot.canvas.h, refs: snapshot.refs });
    const invalid = [...validateDraft(snapshot), ...(compiled.error ? [compiled.error] : [])];
    if (invalid.length) { setNotice(invalid.join("；")); return; }
    submitting.current = true; setBusy(true);
    try {
      await saveQueue.current.catch(() => {});
      if (saveAllowed.current) await api.draftSave(snapshot);
      const images = await Promise.all(snapshot.refs.map(r => snapshot.compressEnabled ? downscaleDataUrl(r.dataUrl, snapshot.maxInputEdge) : Promise.resolve(r.dataUrl)));
      // Recheck actual encoded sizes before the paid request.
      if (snapshot.provider === "bfl") for (const data of images) { const s = await imageSize(data); if (s.width < 256 || s.height < 256 || s.width * s.height > 16_000_000) throw new Error("处理后的参考图不符合 BFL 尺寸限制，请调整压缩上限"); }
      const out = await api.generate({ provider: snapshot.provider, model: snapshot.provider === "bfl" ? "flux-3-image" : MODEL_FLUX3, finalPrompt: compiled.finalPrompt, images, params: { resolution: snapshot.params.resolution, aspectRatio: snapshot.params.aspectRatio, safetyTolerance: snapshot.params.safetyTolerance ?? undefined, grounding: snapshot.provider === "bfl" ? snapshot.params.grounding ?? true : undefined, version: snapshot.provider === "bfl" ? "latest" : undefined } });
      if (!out.images[0]) throw new Error("服务返回成功，但没有图片");
      const im = out.images[0]; const dims = await imageSize(im.dataUrl);
      const image = { uid: crypto.randomUUID(), dataUrl: im.dataUrl, ...dims, name: "生成结果" };
      const { refs, ...recipe } = snapshot;
      const item: HistoryItem = { id: crypto.randomUUID(), createdAt: Date.now(), provider: out.provider, model: out.model, mode: refs.length ? "edit" : "t2i", prompt: snapshot.prompt, finalPrompt: out.finalPrompt, params: { ...snapshot.params }, boxes: snapshot.boxes, canvasWidth: snapshot.canvas.w, canvasHeight: snapshot.canvas.h, inputFiles: [], resultFiles: [], thumb: null, usage: out.usage, cost: out.usage?.cost ?? null, status: "ok", recipe: { ...recipe, refNames: refs.map(r => r.name), refIds: refs.map(r => r.uid!) } };
      const files = [...refs.map((r, i) => ({ kind: "input", name: "input_" + i, data: r.dataUrl })), ...out.images.map((im, i) => ({ kind: "result", name: "result_" + i, data: im.dataUrl }))];
      const r: SavedResult = { image, out, snapshot, item, files, saved: false };
      setResult(r); setView("result"); setOriginal(false);
      try { item.thumb = await makeThumb(im.dataUrl); await api.historySave(item, files); setResult({ ...r, saved: true }); await refreshHistory(); }
      catch (e) { setNotice("生成成功，但历史未保存：" + String(e) + "。请使用结果区的「重新保存历史」。"); }
    } catch (e) {
      setNotice("生成失败：" + (e instanceof Error ? e.message : String(e)) + (e instanceof api.AppError && e.hint ? " · " + e.hint : ""));
    } finally { submitting.current = false; setBusy(false); }
  };

  const useResult = (im: WorkingImage, edit: boolean) => {
    const d = current.current;
    if (!edit && d.refs.length >= 10) { setNotice("参考图已达 10 张，请先移除一张"); return; }
    if (edit) {
      const r = { ...im, uid: crypto.randomUUID() };
      commit({ ...d, refs: [r], baseId: r.uid, boxes: [], canvas: { w: im.width, h: im.height }, params: { ...d.params, aspectRatio: "auto" } }, true);
      setNotice("已以结果新建编辑方案");
    } else commit({ ...d, refs: [...d.refs, { ...im, uid: crypto.randomUUID() }] }, true);
    setView("canvas"); setTab("params"); setSelected(null);
  };
  const restoreHistory = async (item: HistoryItem) => {
    try {
      const refs = await Promise.all(item.inputFiles.map(async (path, i) => ({ ...await api.importImage(path), name: item.recipe?.refNames[i] ?? "参考图 " + (i + 1), uid: item.recipe?.refIds[i] ?? crypto.randomUUID() })));
      const legacy = newDraft(prefs);
      const d = item.recipe ? { ...item.recipe, refs } : { ...legacy, refs, prompt: item.prompt, boxes: item.boxes.map(b => ({ ...b, sourceId: refs[0]?.uid })), provider: item.provider as Draft["provider"], params: { ...DEFAULT_PARAMS, ...item.params }, canvas: { w: item.canvasWidth ?? 1024, h: item.canvasHeight ?? 1024 }, baseId: refs[0]?.uid ?? null };
      commit(withIds(d as Draft), true); setView("canvas"); setTab("params"); setSelected(null); setNotice(item.recipe ? "已恢复全部参考图、提供商、参数、压缩和区域" : "已恢复旧版历史；旧记录未保存的压缩设置使用默认值");
    } catch (e) { setNotice("方案恢复失败，当前工作未改变：" + String(e)); }
  };
  const historyAsInput = async (item: HistoryItem) => { try { if (!item.resultFiles[0]) throw new Error("记录没有结果图片"); useResult(await api.importImage(item.resultFiles[0]), true); } catch (e) { setNotice(String(e)); } };
  const saveResult = async () => {
    if (!result) return;
    try { const ext = result.out.images[0].mediaType.includes("jpeg") ? "jpg" : result.out.images[0].mediaType.includes("webp") ? "webp" : "png";
      const path = await save({ defaultPath: exportDefaultPath(prefs.saveDirectory, "flux-" + result.item.id.slice(0, 8) + "." + ext), filters: [{ name: "图片", extensions: [ext] }] });
      if (path) { await api.saveDataUrl(result.image.dataUrl, path); setNotice("已保存到 " + path); }
    } catch (e) { setNotice("另存为失败：" + String(e)); }
  };
  const base = draft.refs.find(r => r.uid === draft.baseId) ?? null;
  const reference = draft.refs.find(r => r.uid === refPreview);
  const editingBox = draft.boxes.find(b => b.uid === sourceBox);
  const source = draft.refs.find(r => r.uid === editingBox?.sourceId);
  const resultBase = result?.snapshot.refs.find(r => r.uid === result.snapshot.baseId) ?? result?.snapshot.refs[0];
  const canvasBoxes = draft.boxes.filter(b => b.role !== "remove").map(b => {
    const r = draft.refs.find(r => r.uid === b.sourceId);
    return { ...b, srcRect: undefined, rect: b.role === "anchor" && b.srcRect && r ? scaleRect(b.srcRect, { w: r.width, h: r.height }, draft.canvas) : b.rect };
  });
  return <div className="workbench">
    <header className="app-header"><div className="brand"><span className="brand-mark" aria-hidden="true" /><strong>Flux Studio</strong><span className="muted">FLUX.3 Image</span></div>
      <div className="row"><button disabled={!ready} onClick={() => { saveAllowed.current = true; commit(newDraft(prefs), true); setSelected(null); setView("canvas"); setNotice("已新建方案，原方案可撤销恢复"); }}><Plus size={15} />新建</button>
        <button disabled={!undoStack.length} onClick={undo} title="撤销 Ctrl+Z"><ArrowCounterClockwise size={16} /></button><button disabled={!redoStack.length} onClick={redo} title="重做 Ctrl+Shift+Z"><ArrowClockwise size={16} /></button>
        <button onClick={() => setSettings(true)}><GearSix size={16} />设置</button></div>
    </header>
    <div className="workspace">
      <ResizableSidebar widthPercent={prefs.sidebarWidthPercent} onWidthChange={sidebarWidthPercent => setPrefs(p => ({ ...p, sidebarWidthPercent }))}><div className="tabs"><button className={tab === "params" ? "active" : ""} onClick={() => setTab("params")}>方案</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>历史</button></div>
        {tab === "params" ? <Sidebar draft={draft} onChange={onChange} onReorder={boxes => commit({ ...current.current, boxes }, true)} selectedId={selectedId} onSelect={id => { setSelected(id); setView("canvas"); }} onRename={(uid, id) => { commit(renameBox(current.current, uid, id), true); setSelected(id); }} onSource={b => setSourceBox(b.uid!)} providerStatus={pStatus} busy={busy} finalPreview={preview.finalPrompt} errors={errors} onGenerate={() => void generate()} onSettings={() => setSettings(true)} />
          : <><div className="history-error">{historyError && <p role="alert">{historyError}</p>}</div><HistoryPanel saveDirectory={prefs.saveDirectory} items={history} onRefresh={() => void refreshHistory()} onRestoreEdit={item => void restoreHistory(item)} onUseAsInput={item => void historyAsInput(item)} /></>}
      </ResizableSidebar>
      <main className="main-area">
        <div className="canvas-toolbar"><div className="row"><button className={view === "canvas" ? "active" : ""} onClick={() => setView("canvas")}>输出画布</button><button disabled={!result} className={view === "result" ? "active" : ""} onClick={() => setView("result")}>生成结果</button><button disabled={!result || !resultBase} className={view === "compare" ? "active" : ""} onClick={() => setView("compare")}>原图 / 结果对照</button></div>
          {view === "canvas" ? <div className="row"><button className={tool === "box" ? "active" : ""} onClick={() => setTool("box")}><FrameCorners size={16} />画框</button><button className={tool === "pan" ? "active" : ""} onClick={() => setTool("pan")}><Hand size={16} />平移</button><span className="muted">{draft.canvas.w}×{draft.canvas.h}</span></div> : <label className="check"><input type="checkbox" checked={original} onChange={e => setOriginal(e.target.checked)} />查看原尺寸</label>}
        </div>
        <div className="stage">
          {view === "canvas" ? <Canvas image={base} phantom={draft.canvas} boxes={canvasBoxes} selectedId={selectedId} tool={tool} editMode={mode === "edit"} onSelect={setSelected}
            onGestureStart={() => { if (!gesture.current) setUndo(s => [...s.slice(-39), current.current]); gesture.current = true; setRedo([]); }}
            onGestureEnd={() => { gesture.current = false; lastEdit.current = Date.now(); }}
            onChange={boxes => {
              const merged = boxes.map(b => { const prior = current.current.boxes.find(x => x.uid === b.uid); const r = current.current.refs.find(r => r.uid === prior?.sourceId);
                return prior ? { ...prior, rect: b.rect, ...(prior.role === "anchor" && r ? { srcRect: scaleRect(b.rect, current.current.canvas, { w: r.width, h: r.height }) } : {}) } : b;
              }); const existing = current.current.boxes.map(b => b.role === "remove" ? b : merged.find(x => x.uid === b.uid)).filter((b): b is NonNullable<typeof b> => !!b);
              commit({ ...current.current, boxes: [...existing, ...merged.filter(b => !current.current.boxes.some(x => x.uid === b.uid))] });
            }} /> : result && (original ? <div className="original-view">{view === "compare" && resultBase && <img src={resultBase.dataUrl} alt="原图原尺寸" />}<img src={result.image.dataUrl} alt="生成结果原尺寸" /></div> : view === "compare" && resultBase ? <div className="comparison"><figure><figcaption>原图 · 提交时快照</figcaption><img src={resultBase.dataUrl} alt="原图" /></figure><figure><figcaption>生成结果 · {result.image.width}×{result.image.height}</figcaption><img src={result.image.dataUrl} alt="生成结果" /></figure></div> : <Canvas image={result.image} phantom={null} boxes={[]} selectedId={null} tool="pan" readOnly onSelect={() => {}} onChange={() => {}} />)}
        </div>
        {result && <div className="result-actions"><div><strong>最近生成</strong><span className="muted">{result.image.width}×{result.image.height} · {result.item.cost !== null ? "$" + result.item.cost.toFixed(4) : "费用未返回"} · {result.saved ? "已存历史" : "历史尚未保存"}</span></div><div className="row">
          <button onClick={() => void saveResult()}>另存为</button><button onClick={() => void api.copyImage(result.image.dataUrl).then(() => setNotice("图片已复制")).catch(e => setNotice(String(e)))}>复制图片</button><button onClick={() => useResult(result.image, false)}>添加为参考图</button><button onClick={() => useResult(result.image, true)}>继续编辑这张</button>
          {!result.saved && <button disabled={savingResult} onClick={() => void retryHistory(result)}>重新保存历史</button>}</div>
          {result.out.notes.length > 0 && <details><summary>提供商说明</summary>{result.out.notes.map((n, i) => <p className="help" key={i}>{n}</p>)}</details>}
        </div>}
        <section className="reference-strip"><div className="section-heading"><h2>参考素材 · {draft.refs.length}/10</h2><div className="row"><button disabled={!ready || importing || draft.refs.length >= 10} onClick={() => void openFiles()}>添加文件</button><button disabled={!ready || importing || draft.refs.length >= 10} onClick={() => importBatch([api.clipboardImage])}>粘贴图片</button><button disabled={!ready || importing || draft.refs.length >= 10} onClick={() => setUrlDialog(true)}>图片 URL</button></div></div>
          <div className="references">{draft.refs.length ? draft.refs.map((r, i) => <div className="reference" key={r.uid}><button className="reference-image" onClick={() => setRefPreview(r.uid!)}><img src={r.dataUrl} alt={r.name} /></button><div className="reference-meta"><strong title={r.name}>{i + 1}. {r.name}</strong><span>{r.width}×{r.height}{r.uid === draft.baseId ? " · 编辑底图" : ""}</span><div className="row">
            <button title="设为编辑底图，不改变输出画布与参考图顺序" onClick={() => commit({ ...current.current, baseId: r.uid! }, true)}>设为底图</button><button disabled={i === 0} title="向前排序，自动维护提示词引用" onClick={() => { const refs = [...current.current.refs]; [refs[i - 1], refs[i]] = [refs[i], refs[i - 1]]; commit(reorderRefs(current.current, refs), true); }}>前移</button><button disabled={i === draft.refs.length - 1} title="向后排序" onClick={() => { const refs = [...current.current.refs]; [refs[i + 1], refs[i]] = [refs[i], refs[i + 1]]; commit(reorderRefs(current.current, refs), true); }}>后移</button>
            <button onClick={() => { const d = current.current; if (d.boxes.some(b => b.sourceId === r.uid) || d.prompt.includes("<ref_image_" + i + ">")) { setNotice("这张图片被区域或提示词引用。请先修改引用再移除，避免改变方案含义。"); return; } commit({ ...reorderRefs(d, d.refs.filter(x => x.uid !== r.uid)), baseId: d.baseId === r.uid ? null : d.baseId }, true); }}>移除</button>
          </div></div></div>) : <p className="help">支持多选文件、批量拖入、剪贴板和图片 URL</p>}</div>
          {base && <div className="row"><button onClick={() => { const d = resizeCanvas(current.current, { w: base.width, h: base.height }); commit({ ...d, params: { ...d.params, aspectRatio: "auto" } }, true); setNotice("画布采用底图比例；auto 仍可能被提示词要求的比例覆盖"); }}>画布采用底图比例</button><button onClick={() => commit({ ...current.current, baseId: null }, true)}>隐藏底图</button><p className="help">底图按输出比例铺满，仅辅助定位；来源图始终保留原尺寸。</p></div>}
        </section>
      </main>
    </div>
    {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭通知">×</button></div>}
    {settings && <Settings prefs={prefs} onChange={setPrefs} status={pStatus} refresh={refreshProviders} onHistory={() => { setSettings(false); setTab("history"); }} onClose={() => setSettings(false)} />}
    {reference && <Modal title={"参考图 · " + reference.name} large onClose={() => setRefPreview(null)}><div className="image-preview"><img src={reference.dataUrl} alt={reference.name} /></div><p className="help">{reference.width}×{reference.height} px · 预览不会改变方案</p></Modal>}
    {editingBox && source && <Modal title={"编辑源区域 · " + editingBox.id + " · " + source.name} large onClose={() => setSourceBox(null)}>
      <p className="help">拖拽画选替换源区域，或拖动 / 缩放当前框</p>
      <div className="source-editor"><Canvas image={source} phantom={null} boxes={editingBox.srcRect ? [{ ...editingBox, rect: editingBox.srcRect, srcRect: undefined }] : []} selectedId={editingBox.id} tool="box" onSelect={() => {}}
        onGestureStart={() => { setUndo(s => [...s.slice(-39), current.current]); gesture.current = true; }} onGestureEnd={() => { gesture.current = false; }}
        onCreateRect={rect => commit({ ...current.current, boxes: current.current.boxes.map(b => b.uid === editingBox.uid ? { ...b, srcRect: rect } : b) })}
        onChange={boxes => { if (boxes[0]) commit({ ...current.current, boxes: current.current.boxes.map(b => b.uid === editingBox.uid ? { ...b, srcRect: boxes[0].rect } : b) }); }} /></div>
    </Modal>}
    {urlDialog && <Modal title="从 URL 添加参考图" onClose={() => setUrlDialog(false)}><label>图片地址<input type="url" placeholder="https://…" value={imageUrl} onChange={e => setImageUrl(e.target.value)} /></label><p className="help">下载并保存本地副本，后续恢复不依赖原链接。仅支持 http/https 图片。</p><button className="primary" disabled={!imageUrl.trim()} onClick={() => { const url = imageUrl.trim(); importBatch([() => api.importUrl(url)]); setUrlDialog(false); setImageUrl(""); }}>添加参考图</button></Modal>}
  </div>;
}
