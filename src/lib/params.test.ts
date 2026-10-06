import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PARAMS,
  estimateCost,
  phantomSize,
  validateParams,
} from "./params";

describe("params", () => {
  test("默认参数有效（编辑模式）", () => {
    expect(validateParams(DEFAULT_PARAMS, "edit")).toEqual([]);
  });

  test("默认参数有效且支持自动比例文生图", () => {
    const errors = validateParams(DEFAULT_PARAMS, "t2i");
    expect(errors).toEqual([]);
    expect(
      validateParams({ ...DEFAULT_PARAMS, aspectRatio: "auto" }, "t2i"),
    ).toEqual([]);
    expect(
      validateParams({ ...DEFAULT_PARAMS, aspectRatio: "16:9" }, "t2i"),
    ).toEqual([]);
  });

  test("非法分辨率与宽高比", () => {
    expect(
      validateParams({ ...DEFAULT_PARAMS, resolution: "8K" }, "edit").length,
    ).toBe(1);
    expect(
      validateParams({ ...DEFAULT_PARAMS, aspectRatio: "11:9" }, "edit").length,
    ).toBe(1);
  });

  test("safety_tolerance 校验", () => {
    expect(
      validateParams({ ...DEFAULT_PARAMS, safetyTolerance: 3 }, "edit"),
    ).toEqual([]);
    expect(
      validateParams({ ...DEFAULT_PARAMS, safetyTolerance: null }, "edit"),
    ).toEqual([]);
    expect(
      validateParams({ ...DEFAULT_PARAMS, safetyTolerance: 7 }, "edit").length,
    ).toBe(1);
    expect(
      validateParams({ ...DEFAULT_PARAMS, safetyTolerance: 2.5 }, "edit")
        .length,
    ).toBe(1);
    expect(
      validateParams({ ...DEFAULT_PARAMS, safetyTolerance: -1 }, "edit").length,
    ).toBe(1);
  });

  test("BFL 限制 safety 为 0–4，文生图允许 auto", () => {
    expect(validateParams(DEFAULT_PARAMS, "t2i", "bfl")).toEqual([]);
    expect(
      validateParams({ ...DEFAULT_PARAMS, safetyTolerance: 4 }, "edit", "bfl"),
    ).toEqual([]);
    expect(
      validateParams({ ...DEFAULT_PARAMS, safetyTolerance: 5 }, "edit", "bfl"),
    ).toHaveLength(1);
    expect(
      validateParams(
        { ...DEFAULT_PARAMS, safetyTolerance: 5 },
        "edit",
        "openrouter",
      ),
    ).toHaveLength(1);
  });

  test("定价表完整且递增", () => {
    const costs = ["768", "1K", "1.5K", "2K", "4K"].map((r) => estimateCost(r));
    expect(costs.every((c) => c !== null)).toBe(true);
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeGreaterThan(costs[i - 1]!);
    }
    expect(estimateCost("512")).toBeNull();
  });

  test("phantomSize 比例正确", () => {
    expect(phantomSize("1:1")).toEqual({ w: 1024, h: 1024 });
    expect(phantomSize("16:9")).toEqual({ w: 1024, h: 576 });
    expect(phantomSize("9:16")).toEqual({ w: 1024, h: 1820 });
    expect(phantomSize("auto")).toEqual({ w: 1024, h: 1024 }); // 文生图下 auto 视为 1:1
    expect(phantomSize("21:9")).toEqual({ w: 1024, h: 439 });
  });
});
