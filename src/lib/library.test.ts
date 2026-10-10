import { expect, test } from "bun:test";
import { rebaseHistoryPaths } from "./library";
import type { HistoryItem } from "./types";

const base: HistoryItem = {
  id: "task",
  createdAt: 1,
  provider: "bfl",
  model: "flux-3-image",
  mode: "edit",
  prompt: "p",
  finalPrompt: "p",
  params: {},
  boxes: [],
  canvasWidth: 100,
  canvasHeight: 100,
  inputFiles: [],
  resultFiles: [],
  maskFile: null,
  thumb: null,
  usage: {},
  cost: null,
  status: "ok",
};

test("rebaseHistoryPaths rewrites paths under the old root only", () => {
  const item: HistoryItem = {
    ...base,
    inputFiles: [
      "D:\\Library\\workbench\\images\\task\\input_0.png",
      "d:/library/workbench/images/task/input_1.png",
      "images/task/relative.png",
      "C:\\Other\\outside.png",
      "D:\\Library\\workbench-other\\images\\task\\input_2.png",
    ],
    resultFiles: ["D:/Library/workbench/images/task/result_0.png"],
    maskFile: "D:\\Library\\workbench\\images\\task\\mask.png",
    thumbnailAssetId: null,
  };
  const moved = rebaseHistoryPaths(item, "D:\\Library\\workbench", "E:\\Store\\lib");
  expect(moved.inputFiles).toEqual([
    "E:\\Store\\lib\\images\\task\\input_0.png",
    "E:\\Store\\lib\\images\\task\\input_1.png",
    "images/task/relative.png",
    "C:\\Other\\outside.png",
    "D:\\Library\\workbench-other\\images\\task\\input_2.png",
  ]);
  expect(moved.resultFiles).toEqual([
    "E:\\Store\\lib\\images\\task\\result_0.png",
  ]);
  expect(moved.maskFile).toBe("E:\\Store\\lib\\images\\task\\mask.png");
  expect(moved.thumbnailAssetId).toBeNull();
  expect(moved.id).toBe("task");
  expect(item.inputFiles[0]).toBe("D:\\Library\\workbench\\images\\task\\input_0.png");
});

test("rebaseHistoryPaths keeps forward-slash separators and empty fields", () => {
  const item: HistoryItem = {
    ...base,
    inputFiles: ["/home/me/library/images/task/input.png"],
    resultFiles: [],
    maskFile: "/home/me/library/images/task/mask.png",
  };
  const moved = rebaseHistoryPaths(item, "/home/me/library", "/mnt/data/library");
  expect(moved.inputFiles).toEqual(["/mnt/data/library/images/task/input.png"]);
  expect(moved.maskFile).toBe("/mnt/data/library/images/task/mask.png");
  expect(moved.resultFiles).toEqual([]);
});
