import { expect, test } from "bun:test";
import { estimateComfyCredits } from "./pricing";
import { newDraft } from "../lib/workspace";
test("Comfy estimate follows Qwen output count, Pro area and reference charges", () => {
  const d = { ...newDraft(undefined, "qwen"), provider: "comfy" as const };
  d.params = { width: 1024, height: 1024, count: 2 };
  expect(estimateComfyCredits(d)?.min).toBe(18.1);
  d.modelId = "qwen-image-3-pro";
  d.params = { width: 2048, height: 2048, count: 2 };
  d.refs = [
    {
      width: 512,
      height: 512,
      name: "ref",
      dataUrl: "data:image/png;base64,YQ==",
    },
  ];
  expect(estimateComfyCredits(d)?.min).toBeCloseTo(46.17);
});
test("Comfy estimates use quality/size presets and auto ranges without claiming actual usage", () => {
  const d = { ...newDraft(undefined, "gpt"), provider: "comfy" as const };
  d.params = { quality: "low", size: "1024x1024", count: 1 };
  expect(estimateComfyCredits(d)?.min).toBeCloseTo(0.0084 * 211);
  d.params.quality = "max";
  expect(estimateComfyCredits(d)?.min).toBeCloseTo(0.3013 * 211);
  d.params.quality = "auto";
  const estimate = estimateComfyCredits(d)!;
  expect(estimate.max).toBeGreaterThan(estimate.min);
  d.provider = "openrouter" as any;
  expect(estimateComfyCredits(d)).toBeNull();
});
