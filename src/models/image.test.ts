import { expect, test } from "bun:test";
import { newDraft, outputEstimate } from "../lib/workspace";
import { catalog, changeRoute, defaultsFor } from "./catalog";
import { buildRequest, validateModel } from ".";
import { estimateComfyCredits } from "./pricing";
import type { ProviderId } from "../lib/types";

test("new image models have valid defaults on every advertised route", () => {
  for (const model of catalog.models.filter((m) =>
    ["gemini", "seedream"].includes(m.family),
  )) {
    for (const provider of Object.keys(model.routes) as ProviderId[]) {
      const d = {
        ...newDraft(undefined, model.family),
        modelId: model.id,
        provider,
        params: defaultsFor(model.id, provider),
        prompt: "A painted forest",
      };
      expect(validateModel(d)).toEqual([]);
      const req = buildRequest(d, []);
      expect(req.regions).toEqual([]);
      expect(req.mask).toBeUndefined();
      expect(req.params.quality).toBeUndefined();
      expect(req.params.grounding).toBeUndefined();
      if (provider === "comfy") expect(estimateComfyCredits(d)).toBeNull();
      if (model.family === "seedream" && provider === "runware") {
        if (model.id !== "seedream-5-lite")
          expect(req.params.resolution).toBeUndefined();
        expect(req.params.seed).toBeUndefined();
      }
    }
  }
});

test("image dimensions and compiled prompt limits follow the selected route", () => {
  const lite = changeRoute(
    newDraft(undefined, "seedream"),
    "comfy",
    "seedream-5-lite",
  );
  expect(
    validateModel({
      ...lite,
      prompt: "x",
      params: { width: 1024, height: 1024 },
    }).join(),
  ).toContain("输出面积");
  const runware = changeRoute(lite, "runware");
  expect(
    validateModel({ ...runware, prompt: "x".repeat(3001) }).join(),
  ).toContain("3000");
  expect(
    validateModel({
      ...lite,
      prompt: "x",
      params: { width: 2048, height: null },
    }).join(),
  ).toContain("同时设置");
  const gemini = changeRoute(newDraft(undefined, "gemini"), "runware");
  expect(
    validateModel({
      ...gemini,
      prompt: "forest",
      params: { ...gemini.params, aspectRatio: "auto" },
    }).join(),
  ).toContain("参考图");
  expect(
    outputEstimate({
      ...gemini,
      params: { resolution: "512", aspectRatio: "1:1" },
    }),
  ).toEqual({ w: 512, h: 512 });
});
