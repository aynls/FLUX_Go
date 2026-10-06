import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "../lib/api";
import { DEFAULT_PARAMS } from "../lib/params";
import {
  DEFAULT_PREFERENCES,
  newDraft,
  withIds,
  resizeCanvas,
  readSession,
  changeFamily,
  outputEstimate,
  taskIntent,
  workspaceKey,
} from "../lib/workspace";
import { families, fieldsFor, providers, modelById } from "../models/catalog";
import { displayValue } from "../models/parameterLabels";
import { referenceWidth } from "../components/ResizableReferences";
import type {
  Draft,
  FamilyId,
  Preferences,
  WorkspaceSession,
  WorkspaceKey,
  TaskIntent,
} from "../lib/types";

function readPreferences(): Preferences {
  try {
    const raw = JSON.parse(
      localStorage.getItem("lutriui-preferences-v2") ?? "null",
    );
    if (!raw) return DEFAULT_PREFERENCES;
    const p = {
      ...DEFAULT_PREFERENCES,
      ...raw,
      params: { ...DEFAULT_PARAMS, ...raw.params },
    } as Preferences;
    if (!providers.some((provider) => provider.id === p.provider))
      p.provider = "openrouter";
    if (!families.some((f) => f.id === p.defaultFamily))
      p.defaultFamily = "flux";
    p.sidebarWidthPercent = Math.max(
      20,
      Math.min(40, Number(p.sidebarWidthPercent) || 25),
    );
    p.referenceSidebarWidth = referenceWidth(p.referenceSidebarWidth);
    return p;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}
export function useWorkspace(
  submitting: RefObject<boolean>,
  onNotice: (s: string) => void,
  onRequestClose?: () => void,
) {
  const [prefs, setPrefs] = useState<Preferences>(readPreferences);
  const [draft, setDraft] = useState<Draft>(() => newDraft(prefs));
  const current = useRef(draft);
  const tasks = useRef<WorkspaceSession["tasks"]>({
    [workspaceKey(draft)]: draft,
  });
  const [ready, setReady] = useState(false);
  const saveAllowed = useRef(true);
  const saveQueue = useRef(Promise.resolve());
  const [undoStack, setUndo] = useState<Draft[]>([]),
    [redoStack, setRedo] = useState<Draft[]>([]);
  const gesture = useRef(false),
    lastEdit = useRef(0);
  const histories = useRef<
    Partial<Record<WorkspaceKey, { undo: Draft[]; redo: Draft[] }>>
  >({});
  const replace = useCallback((d: Draft) => {
    current.current = d;
    tasks.current[workspaceKey(d)] = d;
    setDraft(d);
  }, []);
  const commit = useCallback(
    (d: Draft, discrete = false) => {
      const previous = current.current;
      if (workspaceKey(previous) !== workspaceKey(d)) {
        histories.current[workspaceKey(previous)] = {
          undo: undoStack,
          redo: redoStack,
        };
        const prior = tasks.current[workspaceKey(d)] ?? {
          ...newDraft(prefs, d.family),
          intent: taskIntent(d),
        };
        setUndo([...(histories.current[workspaceKey(d)]?.undo ?? []), prior]);
      } else if (
        !gesture.current &&
        (discrete || Date.now() - lastEdit.current > 600)
      )
        setUndo((s) => [...s.slice(-39), previous]);
      lastEdit.current = Date.now();
      setRedo([]);
      replace(withIds(d));
    },
    [replace, undoStack, redoStack, prefs],
  );
  const onChange = (next: Draft) => {
    const previous = current.current;
    const fields = fieldsFor(next);
    const discrete =
      next.provider !== previous.provider ||
      next.modelId !== previous.modelId ||
      next.intent !== previous.intent ||
      next.layoutEnabled !== previous.layoutEnabled ||
      next.repeatCount !== previous.repeatCount ||
      next.boxes.length !== previous.boxes.length ||
      next.boxes.some((box) => {
        const old = previous.boxes.find((b) => b.uid === box.uid);
        return old && (old.role !== box.role || old.sourceId !== box.sourceId);
      }) ||
      !!next.mask !== !!previous.mask ||
      next.compressEnabled !== previous.compressEnabled ||
      Object.entries(fields).some(
        ([key, field]) =>
          next.params[key] !== previous.params[key] &&
          (field.kind === "enum" ||
            field.kind === "boolean" ||
            (field.nullable &&
              (next.params[key] == null) !== (previous.params[key] == null))),
      );
    let d = next;
    if (
      fields.aspectRatio &&
      (next.params.aspectRatio !== current.current.params.aspectRatio ||
        next.params.resolution !== current.current.params.resolution ||
        next.provider !== current.current.provider)
    )
      d = resizeCanvas(next, outputEstimate(next));
    if (
      (fields.size && next.params.size !== current.current.params.size) ||
      (fields.width &&
        (next.params.width !== current.current.params.width ||
          next.params.height !== current.current.params.height))
    ) {
      const size = outputEstimate(next);
      if (size.w > 0 && size.h > 0) d = resizeCanvas(next, size);
    }
    commit(d, discrete);
    if (
      next.modelId !== previous.modelId ||
      next.provider !== previous.provider
    ) {
      const restored =
        previous.routeSettings?.[next.modelId + ":" + next.provider];
      const changes = Object.entries(fields).flatMap(([key, field]) =>
        key !== "count" &&
        previous.params[key] !== undefined &&
        previous.params[key] !== d.params[key]
          ? [
              `${field.label} ${displayValue(key, previous.params[key])} → ${displayValue(key, d.params[key])}`,
            ]
          : [],
      );
      const route = `${modelById(d.modelId)?.label} · ${providers.find((p) => p.id === d.provider)?.label}`;
      onNotice(
        `${restored ? "已恢复" : "已切换至"} ${route}${restored ? " 的参数" : ""}${changes.length ? "；" + changes.join("，") : ""}`,
      );
    }
  };
  const undo = () => {
    if (gesture.current) return;
    const prior = undoStack.at(-1);
    if (!prior) return;
    const previous = current.current;
    setRedo((s) => [...s, previous]);
    setUndo((s) => s.slice(0, -1));
    replace(prior);
    onNotice("");
    lastEdit.current = 0;
  };
  const redo = () => {
    if (gesture.current) return;
    const next = redoStack.at(-1);
    if (!next) return;
    const previous = current.current;
    setUndo((s) => [...s, previous]);
    setRedo((s) => s.slice(0, -1));
    replace(next);
    onNotice("");
    lastEdit.current = 0;
  };
  const draftForIntent = (intent: TaskIntent) => {
    const d = current.current;
    return (
      tasks.current[intent] ?? {
        ...newDraft(prefs, d.family),
        provider: d.provider,
        modelId: d.modelId,
        params: { ...d.params },
        intent,
      }
    );
  };
  const switchIntent = (intent: TaskIntent) => {
    if (gesture.current) return;
    const key: WorkspaceKey = intent;
    if (key === workspaceKey(current.current)) return;
    histories.current[workspaceKey(current.current)] = {
      undo: undoStack,
      redo: redoStack,
    };
    setUndo(histories.current[key]?.undo ?? []);
    setRedo(histories.current[key]?.redo ?? []);
    replace(draftForIntent(intent));
    lastEdit.current = 0;
  };
  const switchFamily = (family: FamilyId) =>
    onChange(changeFamily(current.current, family, prefs));
  const session = useCallback(
    (d = current.current): WorkspaceSession => ({
      schema: 2,
      activeIntent: taskIntent(d),
      tasks: { ...tasks.current, [taskIntent(d)]: d },
    }),
    [],
  );
  const persist = useCallback(
    async (d = current.current) => {
      if (!api.isDesktop()) return;
      await saveQueue.current.catch(() => {});
      if (saveAllowed.current) await api.draftSave(session(d));
    },
    [session],
  );
  const reset = () => {
    saveAllowed.current = true;
    commit(
      {
        ...newDraft(prefs, current.current.family),
        intent: taskIntent(current.current),
      },
      true,
    );
  };
  const closeApp = async () => {
    try {
      await persist();
      await getCurrentWindow().destroy();
    } catch (e) {
      onNotice("关闭前保存失败：" + String(e));
    }
  };
  useEffect(() => {
    if (!api.isDesktop()) {
      setReady(true);
      return;
    }
    let alive = true;
    api
      .draftLoad()
      .then((raw) => {
        if (!alive) return;
        const saved = readSession(raw);
        if (saved) {
          tasks.current = saved.tasks;
          replace(saved.tasks[saved.activeIntent]!);
        }
      })
      .catch((e) => {
        if (!alive) return;
        saveAllowed.current = false;
        onNotice(
          "草稿恢复失败，已暂停保存以保留原文件。新建方案后可重新保存：" +
            String(e),
        );
      })
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [replace, onNotice]);
  useEffect(() => {
    if (!ready || !saveAllowed.current || !api.isDesktop()) return;
    const timer = window.setTimeout(() => {
      const snapshot = session(draft);
      saveQueue.current = saveQueue.current
        .catch(() => {})
        .then(() => api.draftSave(snapshot))
        .catch((e) => onNotice("草稿保存失败：" + String(e)));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [draft, ready, session, onNotice]);
  useEffect(() => {
    if (!api.isDesktop()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (submitting.current) {
          onRequestClose?.();
          return;
        }
        try {
          await persist();
          await getCurrentWindow().destroy();
        } catch (e) {
          onNotice("关闭前保存失败：" + String(e) + "。请修复后再关闭。");
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else off = fn;
      })
      .catch((e) => onNotice("关闭保护初始化失败：" + String(e)));
    return () => {
      disposed = true;
      off?.();
    };
  }, [persist, submitting, onNotice, onRequestClose]);
  useEffect(() => {
    try {
      localStorage.setItem("lutriui-preferences-v2", JSON.stringify(prefs));
    } catch (e) {
      onNotice("偏好保存失败：" + String(e));
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        prefs.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : prefs.theme;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [prefs, onNotice]);
  const beginGesture = () => {
    const previous = current.current;
    if (!gesture.current) setUndo((s) => [...s.slice(-39), previous]);
    gesture.current = true;
    setRedo([]);
  };
  const endGesture = () => {
    gesture.current = false;
    lastEdit.current = Date.now();
  };
  return {
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
    switchFamily,
    switchIntent,
    draftForIntent,
    reset,
    closeApp,
    persist,
    beginGesture,
    endGesture,
  };
}
