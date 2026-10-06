import { useEffect, useRef, useState, type RefObject } from "react";
import * as api from "../lib/api";
import { migrateDraft, taskIntent } from "../lib/workspace";
import { routeFor } from "../models/catalog";
import { makeThumb } from "../lib/image";
import {
  executeGeneration,
  queuedGeneration,
  type SavedResult,
} from "./generation";
import type { Draft, GenerationTask, HistoryItem } from "../lib/types";

type Job = ReturnType<typeof queuedGeneration>;
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
        total: routeFor(job.snapshot)?.parameters.count
          ? (job.snapshot.params.count ?? 1)
          : 1,
        phase: "preparing",
      });
      try {
        await api.historySave({ ...job.item, status: "running" }, job.files);
        await refresh();
        const result = await executeGeneration(
          job.snapshot,
          (progress) => {
            const changed =
              job.item.phase !== progress.phase ||
              (progress.taskId && job.item.taskId !== progress.taskId);
            job.item = {
              ...job.item,
              phase: progress.phase,
              taskId: progress.taskId ?? job.item.taskId,
            };
            if (alive.current) setTask((t) => (t ? { ...t, ...progress } : t));
            if (changed) void refresh();
          },
          job.item,
        );
        result.item.taskId = job.item.taskId ?? null;
        result.item.phase = "completed";
        try {
          result.item.thumb = await makeThumb(result.image.dataUrl);
          await api.historySave(result.item, result.files);
          result.saved = true;
        } catch (e) {
          callbacks.current.onNotice(
            "结果已完成，但历史保存失败，可从结果区重新保存：" + String(e),
          );
        }
        if (alive.current) callbacks.current.onResult(result);
      } catch (e) {
        const message =
          (e instanceof Error ? e.message : String(e)) +
          (e instanceof api.AppError && e.hint ? " · " + e.hint : "");
        try {
          await api.historySave(
            { ...job.item, status: "failed", error: message },
            job.files,
          );
        } catch (saveError) {
          callbacks.current.onNotice(
            "任务失败且历史更新失败：" + message + "；" + String(saveError),
          );
        }
        if (alive.current) callbacks.current.onNotice("任务失败：" + message);
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
      throw new Error("生成次数须为 1–20 的整数");
    if (jobs.current.length + count > 20)
      throw new Error("队列最多容纳 20 条等待任务，请减少次数或稍后提交");
    locked.current = true;
    setAccepting(true);
    sync();
    let accepted = 0;
    let id: string | undefined;
    try {
      for (let i = 0; i < count; i++) {
        const job = queuedGeneration(structuredClone(snapshot));
        await api.historySave(job.item, job.files);
        jobs.current.push(job);
        accepted++;
        id = job.item.id;
        sync();
      }
      await refresh();
      return id;
    } catch (e) {
      await refresh();
      throw new Error(
        `已加入 ${accepted}/${count} 条任务；剩余任务未提交：${String(e)}`,
      );
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
            const job = queuedGeneration(
              migrateDraft({ ...item.recipe, refs, mask }),
            );
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
