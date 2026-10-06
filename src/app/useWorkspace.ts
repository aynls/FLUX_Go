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
  migrateSession,
  outputEstimate,
} from "../lib/workspace";
import { families, fieldsFor, providers } from "../models/catalog";
import type {
  Draft,
  FamilyId,
  Preferences,
  WorkspaceSession,
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
  const bank = useRef<WorkspaceSession["workspaces"]>({
    [draft.family]: draft,
  });
  const [ready, setReady] = useState(false);
  const saveAllowed = useRef(true);
  const saveQueue = useRef(Promise.resolve());
  const [undoStack, setUndo] = useState<Draft[]>([]),
    [redoStack, setRedo] = useState<Draft[]>([]);
  const gesture = useRef(false),
    lastEdit = useRef(0);
  const histories = useRef<
    Partial<Record<FamilyId, { undo: Draft[]; redo: Draft[] }>>
  >({});
  const replace = useCallback((d: Draft) => {
    current.current = d;
    bank.current[d.family] = d;
    setDraft(d);
  }, []);
  const commit = useCallback(
    (d: Draft, discrete = false) => {
      const previous = current.current;
      if (!gesture.current && (discrete || Date.now() - lastEdit.current > 600))
        setUndo((s) => [...s.slice(-39), previous]);
      lastEdit.current = Date.now();
      setRedo([]);
      replace(withIds(d));
    },
    [replace],
  );
  const onChange = (next: Draft) => {
    const previous = current.current;
    const fields = fieldsFor(next);
    const discrete =
      next.provider !== previous.provider ||
      next.modelId !== previous.modelId ||
      next.intent !== previous.intent ||
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
  };
  const undo = () => {
    if (gesture.current) return;
    const prior = undoStack.at(-1);
    if (!prior) return;
    const previous = current.current;
    setRedo((s) => [...s, previous]);
    setUndo((s) => s.slice(0, -1));
    replace(prior);
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
    lastEdit.current = 0;
  };
  const switchFamily = (family: FamilyId) => {
    if (gesture.current) return;
    if (family === current.current.family) return;
    histories.current[current.current.family] = {
      undo: undoStack,
      redo: redoStack,
    };
    setUndo(histories.current[family]?.undo ?? []);
    setRedo(histories.current[family]?.redo ?? []);
    replace(bank.current[family] ?? newDraft(prefs, family));
    lastEdit.current = 0;
  };
  const session = useCallback(
    (d = current.current): WorkspaceSession => ({
      schema: 1,
      activeFamily: d.family,
      workspaces: { ...bank.current, [d.family]: d },
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
    commit(newDraft(prefs, current.current.family), true);
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
        const saved = migrateSession(raw);
        if (saved) {
          bank.current = saved.workspaces;
          replace(saved.workspaces[saved.activeFamily]!);
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
    reset,
    closeApp,
    persist,
    beginGesture,
    endGesture,
  };
}
