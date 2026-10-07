import { expect, test } from "bun:test";
import { readDraft, newDraft, outputEstimate } from "../lib/workspace";
import { catalog, changeRoute, defaultsFor } from "./catalog";
import { buildRequest, validateModel } from ".";
import { estimateComfyCredits } from "./pricing";
import type { ProviderId } from "../lib/types";

test("Nano Banana 2.1 restores Comfy and Runware controls independently", () => {
  const comfy = changeRoute(newDraft(undefined, "gemini"), "comfy", "gemini-nano-banana-2.1");
  comfy.prompt = "A painted forest";
  comfy.params = { ...comfy.params, aspectRatio: "9:21", thinkingLevel: "high", responseText: true };
  expect(validateModel(comfy)).toEqual([]);
  const runware = changeRoute(comfy, "runware");
  expect(runware.params.aspectRatio).not.toBe("9:21");
  expect(buildRequest(runware, []).params.responseText).toBeUndefined();
  expect(buildRequest(runware, []).params.includeThoughts).toBeUndefined();
  runware.params = { ...runware.params, resolution: "4K", aspectRatio: "8:1", searchMode: "images", seed: 123 };
  expect(validateModel(runware)).toEqual([]);
  expect(outputEstimate(runware)).toEqual({ w: 11712, h: 1408 });
  expect(buildRequest(runware, []).params).toMatchObject({ searchMode: "images", seed: 123 });
  expect(changeRoute(runware, "comfy").params).toEqual(comfy.params);
  expect(changeRoute(changeRoute(runware, "comfy"), "runware").params).toEqual(runware.params);
  expect(buildRequest(changeRoute(runware, "google"), []).params.seed).toBeUndefined();
});

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

test("Nano Banana 2.1 switches without losing old model settings or edit inputs", () => {
  const previous = {
    ...newDraft(undefined, "gemini"),
    prompt: "Preserve the subject and change the background",
    params: { resolution: "512", aspectRatio: "8:1", count: 1 },
  };
  expect(previous.modelId).toBe("gemini-3.1-flash-image");
  const selected = changeRoute(
    previous,
    "openrouter",
    "gemini-nano-banana-2.1",
  );
  expect(selected.params.resolution).toBe("1K");
  expect(selected.params.aspectRatio).toBe("8:1");
  expect(changeRoute(selected, "openrouter", previous.modelId).params).toEqual(
    previous.params,
  );
  const refs = Array.from({ length: 14 }, (_, i) => ({
    uid: `ref-${i}`,
    name: `Reference ${i}`,
    width: 768,
    height: 768,
    dataUrl: `data:image/png;base64,${i}`,
  }));
  for (const provider of ["openrouter", "google"] as const) {
    const draft = {
      ...changeRoute(selected, provider),
      intent: "edit" as const,
      refs,
      baseId: refs[0].uid,
      params: { resolution: "4K", aspectRatio: "8:1" },
    };
    expect(validateModel(draft)).toEqual([]);
    const request = buildRequest(
      draft,
      refs.map((r) => r.dataUrl),
    );
    expect(request.model).toBe("gemini-nano-banana-2.1");
    expect(request.images).toEqual(refs.map((r) => r.dataUrl));
    expect(request.params).toEqual({
      resolution: "4K",
      aspectRatio: "8:1",
      ...(provider === "openrouter"
        ? { count: 1 }
        : {
            thinkingLevel: "medium",
            includeThoughts: false,
            responseText: false,
            searchMode: "none",
          }),
    });
    expect(readDraft(JSON.parse(JSON.stringify(draft)))).toMatchObject(draft);
    expect(
      validateModel({ ...draft, refs: [...refs, refs[0]] }).join(),
    ).toContain("14");
    expect(
      validateModel({
        ...draft,
        params: { ...draft.params, resolution: "512" },
      }).join(),
    ).toContain("512");
  }
});
