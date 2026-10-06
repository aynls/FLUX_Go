import { useEffect, useRef, useState, type RefObject } from "react";
import * as api from "../lib/api";
import { migrateDraft, taskIntent } from "../lib/workspace";
import { routeFor, singleImageDraft } from "../models/catalog";
import { makeThumb } from "../lib/image";
import {
  executeGeneration,
  queuedGeneration,
  mergeGenerationResults,
  type SavedResult,
} from "./generation";
import type { Draft, GenerationTask, HistoryItem } from "../lib/types";

type Job = ReturnType<typeof queuedGeneration> & { snapshots?: Draft[] };
export function useGenerationQueue(
  active: RefObject<boolean>,
  onResult: (result: SavedResult) => void,
  onHistory: () => Promise<void>,
  onNotice: (message: string) => void,
) {
  const [task, setTask] = useState<GenerationTask | null>(null);
  const [pending, setPending] = useState<HistoryItem[]>([]);
  const [accepting, setAccepting] = useState(false);
  const [ready, setReady] = useState(false);
  const jobs = useRef<Job[]>([]);
  const running = useRef<Job | null>(null);
  const locked = useRef(false);
  const alive = useRef(true);
  const restoreEpoch = useRef(0);
  const callbacks = useRef({ onResult, onHistory, onNotice });
  callbacks.current = { onResult, onHistory, onNotice };
  const sync = () => {
    active.current =
      !!running.current || jobs.current.length > 0 || locked.current;
    if (alive.current) setPending(jobs.current.map((j) => j.item));
  };
  const refresh = () =>
    callbacks.current
      .onHistory()
      .catch((e) => callbacks.current.onNotice("历史刷新失败：" + String(e)));
  const drain = async () => {
    if (running.current || !alive.current) return;
    while (jobs.current.length && alive.current) {
      const job = jobs.current.shift()!;
      running.current = job;
      sync();
      setTask({
        family: job.snapshot.family,
        intent: taskIntent(job.snapshot),
        modelId: job.snapshot.modelId,
        provider: job.snapshot.provider,
        startedAt: Date.now(),
        total:
          job.snapshots?.length ??
          (routeFor(job.snapshot)?.parameters.count
            ? (job.snapshot.params.count ?? 1)
            : 1),
        phase: "preparing",
      });
      let combined: SavedResult | null = null;
      const snapshots = job.snapshots ?? [job.snapshot];
      const requests = job.item.batch?.requests;
      try {
        job.item = { ...job.item, status: "running" };
        for (let i = 0; i < snapshots.length; i++) {
          if (requests) requests[i].status = "running";
          job.item = { ...job.item, phase: "preparing", taskId: null };
          if (alive.current)
            setTask((t) =>
              t
                ? { ...t, phase: "preparing", taskId: undefined, completed: i }
                : t,
            );
          await api.historySave(job.item, job.files);
          await refresh();
          try {
            const result = await executeGeneration(
              snapshots[i],
              (progress) => {
                const changed =
                  job.item.phase !== progress.phase ||
                  (progress.taskId && job.item.taskId !== progress.taskId);
                job.item = {
                  ...job.item,
                  phase: progress.phase,
                  taskId: progress.taskId ?? job.item.taskId,
                };
                if (requests && progress.taskId)
                  requests[i].taskId = progress.taskId;
                if (alive.current)
                  setTask((t) =>
                    t
                      ? {
                          ...t,
                          ...progress,
                          completed:
                            snapshots.length > 1 ? i : progress.completed,
                        }
                      : t,
                  );
                if (changed) void refresh();
              },
              job.item,
              requests?.[i].requestId,
            );
            if (requests) requests[i].status = "ok";
            combined = mergeGenerationResults(combined, result);
            job.item = {
              ...combined.item,
              batch: job.item.batch,
              status: "running",
              error: job.item.error,
              taskId: job.item.taskId,
              phase: "saving",
            };
            job.files = combined.files;
            if (!job.item.thumb)
              job.item.thumb = await makeThumb(combined.image.dataUrl).catch(
                () => null,
              );
          } catch (e) {
            const message =
              (e instanceof Error ? e.message : String(e)) +
              (e instanceof api.AppError && e.hint ? " · " + e.hint : "");
            if (requests) {
              requests[i].status = "failed";
              requests[i].error = message;
            }
            job.item.error = [
              job.item.error,
              `第 ${i + 1} 次请求失败：${message}`,
            ]
              .filter(Boolean)
              .join("；");
          }
          // Save every finished request before issuing another paid request.
          const saved = await api.historySave(job.item, job.files);
          job.item = { ...saved, batch: job.item.batch };
          if (combined) {
            combined = { ...combined, item: job.item, saved: true };
            if (alive.current) callbacks.current.onResult(combined);
          }
          await refresh();
          if (alive.current)
            setTask((t) => (t ? { ...t, completed: i + 1 } : t));
        }
        job.item = {
          ...job.item,
          status: combined ? (job.item.error ? "partial" : "ok") : "failed",
          phase: "completed",
        };
        if (combined) {
          combined.item = job.item;
          try {
            await api.historySave(job.item, job.files);
            combined.saved = true;
          } catch (e) {
            callbacks.current.onNotice(
              "结果已完成，但历史保存失败，可从结果区重新保存：" + String(e),
            );
          }
          if (alive.current) callbacks.current.onResult(combined);
        } else {
          await api.historySave(job.item, job.files);
          callbacks.current.onNotice("任务失败：" + job.item.error);
        }
      } catch (e) {
        const message = "批次停止，未继续提交剩余请求：" + String(e);
        for (const request of requests ?? []) {
          if (request.status === "queued" || request.status === "running") {
            request.status = "skipped";
            request.error = "历史保存失败，未发送此请求";
          }
        }
        job.item = {
          ...job.item,
          status: combined ? "partial" : "failed",
          error: [job.item.error, message].filter(Boolean).join("；"),
        };
        try {
          await api.historySave(job.item, job.files);
          if (combined) combined.saved = true;
        } catch (saveError) {
          callbacks.current.onNotice("历史更新失败：" + String(saveError));
        }
        if (combined && alive.current) {
          combined.item = job.item;
          callbacks.current.onResult(combined);
        }
        if (alive.current) callbacks.current.onNotice(message);
      } finally {
        await refresh();
        running.current = null;
        sync();
        if (alive.current) setTask(null);
      }
    }
  };
  const enqueue = async (snapshot: Draft, count = 1) => {
    if (locked.current || !ready) return;
    if (!Number.isInteger(count) || count < 1 || count > 20)
      throw new Error("生成张数须为 1–20 的整数");
    if (
      jobs.current.reduce((n, job) => n + (job.snapshots?.length ?? 1), 0) +
        count >
      20
    )
      throw new Error("队列最多容纳 20 张等待图片，请减少张数或稍后提交");
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
      jobs.current.push(job);
      sync();
      await refresh();
      return job.item.id;
    } finally {
      locked.current = false;
      setAccepting(false);
      sync();
      void drain();
    }
  };
  const cancel = async (id: string) => {
    const index = jobs.current.findIndex((j) => j.item.id === id);
    if (index < 0) return;
    const [job] = jobs.current.splice(index, 1);
    sync();
    try {
      await api.historySave({ ...job.item, status: "cancelled" }, job.files);
      await refresh();
    } catch (e) {
      jobs.current.unshift(job);
      sync();
      callbacks.current.onNotice(
        "取消状态保存失败，任务仍在队列中：" + String(e),
      );
    }
  };
  useEffect(() => {
    alive.current = true;
    const epoch = ++restoreEpoch.current;
    const isCurrent = () => alive.current && restoreEpoch.current === epoch;
    const restore = async () => {
      try {
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
            const snapshot = migrateDraft({ ...item.recipe, refs, mask });
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
            jobs.current.push(job);
          } catch (e) {
            await api.historySave(
              {
                ...item,
                status: "failed",
                error: "队列恢复失败：" + String(e),
              },
              [],
            );
          }
        }
        sync();
        if (isCurrent()) {
          setReady(true);
          void drain();
        }
      } catch (e) {
        callbacks.current.onNotice("队列读取失败：" + String(e));
      }
    };
    void restore();
    return () => {
      alive.current = false;
      restoreEpoch.current++;
    };
  }, []);
  return { task, pending, accepting, ready, enqueue, cancel };
}
