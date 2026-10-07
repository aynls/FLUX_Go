import { useEffect, useRef, useState, type RefObject } from "react";
import * as api from "../lib/api";
import { readDraft, taskIntent } from "../lib/workspace";
import { singleImageDraft } from "../models/catalog";
import { makeThumb } from "../lib/image";
import {
  executeGeneration,
  queuedGeneration,
  mergeGenerationResults,
  type SavedResult,
} from "./generation";
import type { Draft, GenerationTask } from "../lib/types";

type Job = ReturnType<typeof queuedGeneration> & {
  snapshots?: Draft[];
  stopRequested?: boolean;
};
export function useGenerationTasks(
  active: RefObject<boolean>,
  onResult: (result: SavedResult) => void,
  onHistory: () => Promise<void>,
  onNotice: (message: string) => void,
) {
  const [tasks, setTasks] = useState<
    (GenerationTask & { id: string; prompt: string })[]
  >([]);
  const [accepting, setAccepting] = useState(false);
  const [ready, setReady] = useState(false);
  const running = useRef(new Map<string, Job>());
  const progress = useRef(new Map<string, GenerationTask>());
  const locked = useRef(false);
  const alive = useRef(true);
  const restoreEpoch = useRef(0);
  const callbacks = useRef({ onResult, onHistory, onNotice });
  callbacks.current = { onResult, onHistory, onNotice };
  const sync = () => {
    active.current = running.current.size > 0 || locked.current;
    if (alive.current)
      setTasks(
        Array.from(progress.current, ([id, task]) => ({
          ...task,
          id,
          prompt: running.current.get(id)?.snapshot.prompt ?? "",
        })),
      );
  };
  const updateTask = (
    id: string,
    update: (task: GenerationTask | null) => GenerationTask | null,
  ) => {
    const task = update(progress.current.get(id) ?? null);
    if (task) progress.current.set(id, task);
    else progress.current.delete(id);
    sync();
  };
  const refresh = () =>
    callbacks.current
      .onHistory()
      .catch((e) => callbacks.current.onNotice("历史刷新失败：" + String(e)));
  const run = async (job: Job) => {
    if (!alive.current || running.current.has(job.item.id)) return;
    running.current.set(job.item.id, job);
    const snapshots = job.snapshots ?? [job.snapshot];
    const requests = job.item.batch?.requests;
    updateTask(job.item.id, () => ({
      family: job.snapshot.family,
      intent: taskIntent(job.snapshot),
      modelId: job.snapshot.modelId,
      provider: job.snapshot.provider,
      startedAt: Date.now(),
      total: snapshots.length,
      phase: "preparing",
      remainingRequests: snapshots.length,
    }));
    let combined: SavedResult | null = null;
    let completed = 0;
    let persistenceFailed = false;
    // Serialize writes to this history record, while provider requests run concurrently.
    let writes: Promise<void> = Promise.resolve();
    const persist = (update?: () => void) => {
      const next = writes.then(async () => {
        update?.();
        const saved = await api.historySave(job.item, job.files);
        job.item = {
          ...saved,
          batch: job.item.batch,
          error: job.item.error,
          phase: job.item.phase,
          taskId: job.item.taskId,
        };
      });
      writes = next.catch(() => {
        persistenceFailed = true;
      });
      return next;
    };
    const errorMessage = (e: unknown) =>
      (e instanceof Error ? e.message : String(e)) +
      (e instanceof api.AppError && e.hint ? " · " + e.hint : "");
    try {
      job.item = { ...job.item, status: "running", phase: "preparing" };
      await persist();
      await refresh();
      await Promise.all(
        snapshots.map(async (snapshot, i) => {
          try {
            const result = await executeGeneration(
              snapshot,
              (event) => {
                const changed =
                  job.item.phase !== event.phase ||
                  (!!event.taskId && job.item.taskId !== event.taskId);
                job.item = {
                  ...job.item,
                  phase: event.phase,
                  taskId: event.taskId ?? job.item.taskId,
                };
                if (requests && event.taskId) requests[i].taskId = event.taskId;
                if (alive.current)
                  updateTask(job.item.id, (t) =>
                    t ? { ...t, ...event, completed } : t,
                  );
                if (changed) void refresh();
              },
              job.item,
              requests?.[i].requestId,
              async () => {
                await persist(() => {
                  if (
                    job.stopRequested ||
                    persistenceFailed ||
                    !alive.current
                  ) {
                    if (requests) {
                      requests[i].status = "skipped";
                      requests[i].error = "请求未发送";
                    }
                    throw new Error("请求未发送");
                  }
                  if (requests) requests[i].status = "running";
                });
                if (alive.current)
                  updateTask(job.item.id, (t) =>
                    t
                      ? {
                          ...t,
                          remainingRequests:
                            requests?.filter((r) => r.status === "queued")
                              .length ?? 0,
                        }
                      : t,
                  );
              },
            );
            const thumb = await makeThumb(result.image.dataUrl).catch(
              () => null,
            );
            await persist(() => {
              if (requests) requests[i].status = "ok";
              combined = mergeGenerationResults(combined, result);
              job.item = {
                ...combined.item,
                batch: job.item.batch,
                status: "running",
                error: job.item.error,
                taskId: job.item.taskId,
                phase: "saving",
                thumb: job.item.thumb ?? thumb,
              };
              job.files = combined.files;
            });
            if (combined && alive.current)
              callbacks.current.onResult({
                ...combined,
                item: job.item,
                saved: true,
              });
          } catch (e) {
            const message = errorMessage(e);
            // A result whose history write failed remains available for manual saving.
            if (
              requests?.[i].status !== "skipped" &&
              requests?.[i].status !== "ok"
            ) {
              if (requests) {
                requests[i].status = "failed";
                requests[i].error = message;
              }
            }
            if (requests?.[i].status !== "skipped")
              job.item.error = [
                job.item.error,
                `第 ${i + 1} 次请求失败：${message}`,
              ]
                .filter(Boolean)
                .join("；");
            if (combined && alive.current)
              callbacks.current.onResult({
                ...combined,
                item: job.item,
                saved: false,
              });
          } finally {
            completed++;
            if (alive.current)
              updateTask(job.item.id, (t) => (t ? { ...t, completed } : t));
            await refresh();
          }
        }),
      );
    } catch (e) {
      job.item.error = "任务停止，历史保存失败：" + errorMessage(e);
      for (const request of requests ?? []) {
        if (request.status === "queued") {
          request.status = "skipped";
          request.error = "历史保存失败，未发送此请求";
        }
      }
    }
    // All request handlers have settled before the final aggregate is saved.
    const result = combined as SavedResult | null;
    job.item = {
      ...job.item,
      status: result
        ? job.item.error || job.stopRequested
          ? "partial"
          : "ok"
        : "failed",
      phase: "completed",
    };
    let saved = false;
    try {
      await persist();
      saved = true;
    } catch (e) {
      callbacks.current.onNotice(
        "历史保存失败，可从结果区重新保存：" + errorMessage(e),
      );
    }
    if (result && alive.current)
      callbacks.current.onResult({ ...result, item: job.item, saved });
    else if (alive.current)
      callbacks.current.onNotice("任务失败：" + job.item.error);
    await refresh();
    running.current.delete(job.item.id);
    updateTask(job.item.id, () => null);
  };
  const submit = async (snapshot: Draft, count = 1) => {
    if (locked.current || !ready) return;
    if (!Number.isInteger(count) || count < 1 || count > 20)
      throw new Error("生成张数须为 1–20 的整数");
    locked.current = true;
    setAccepting(true);
    sync();
    try {
      const entries = Array.from({ length: count }, () =>
        queuedGeneration(singleImageDraft(structuredClone(snapshot))),
      );
      const job: Job = {
        ...entries[0],
        snapshots: entries.map((entry) => entry.snapshot),
      };
      job.item.batch = {
        requests: entries.map((entry) => ({
          requestId: entry.item.id,
          seed: entry.snapshot.params.seed,
          status: "queued",
        })),
      };
      await api.historySave(job.item, job.files);
      // Each submission starts independently after its snapshot is persisted.
      void run(job);
      return job.item.id;
    } finally {
      locked.current = false;
      setAccepting(false);
      sync();
    }
  };
  const stopRemaining = (id?: string) => {
    const job = id
      ? running.current.get(id)
      : running.current.values().next().value;
    if (
      !job ||
      job.stopRequested ||
      !job.item.batch?.requests.some((r) => r.status === "queued")
    )
      return;
    job.stopRequested = true;
    job.item.batch.stopped = true;
    for (const request of job.item.batch.requests) {
      if (request.status === "queued") {
        request.status = "skipped";
        request.error = "用户停止后续生成，未发送此请求";
      }
    }
    updateTask(job.item.id, (t) =>
      t ? { ...t, remainingRequests: 0, stopRequested: true } : t,
    );
    callbacks.current.onNotice("已停止后续请求，当前请求仍会接收并保存结果");
  };
  useEffect(() => {
    alive.current = true;
    const epoch = ++restoreEpoch.current;
    const isCurrent = () => alive.current && restoreEpoch.current === epoch;
    const restore = async () => {
      try {
        const restored: Job[] = [];
        for (const item of (await api.historyList())
          .filter((it) => it.status === "queued")
          .sort((a, b) => a.createdAt - b.createdAt)) {
          if (!isCurrent()) return;
          try {
            if (!item.recipe) throw new Error("任务缺少请求快照");
            const refs = await Promise.all(
              item.inputFiles.map(async (path, i) => ({
                ...(await api.importImage(path)),
                name: item.recipe!.refNames[i],
                uid: item.recipe!.refIds[i],
                purpose: item.recipe!.refPurposes?.[i],
                note: item.recipe!.refNotes?.[i],
              })),
            );
            const mask = item.maskFile
              ? {
                  ...(await api.importImage(item.maskFile)),
                  name: item.recipe.maskName ?? "编辑蒙版",
                }
              : null;
            const snapshot = readDraft({ ...item.recipe, refs, mask });
            const job: Job = queuedGeneration(snapshot);
            if (item.batch)
              job.snapshots = item.batch.requests.map((request) => ({
                ...snapshot,
                params: { ...snapshot.params, seed: request.seed },
              }));
            if (!isCurrent()) return;
            job.item = {
              ...item,
              inputFiles: [],
              resultFiles: [],
              maskFile: null,
            };
            restored.push(job);
          } catch (e) {
            await api.historySave(
              {
                ...item,
                status: "failed",
                error: "任务恢复失败：" + String(e),
              },
              [],
            );
          }
        }
        sync();
        if (isCurrent()) {
          setReady(true);
          for (const job of restored) void run(job);
        }
      } catch (e) {
        callbacks.current.onNotice("任务读取失败：" + String(e));
      }
    };
    void restore();
    return () => {
      alive.current = false;
      restoreEpoch.current++;
    };
  }, []);
  return {
    task: tasks[0] ?? null,
    tasks,
    accepting,
    ready,
    submit,
    stopRemaining,
  };
}
