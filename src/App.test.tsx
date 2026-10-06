import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type {
  Draft,
  WorkspaceSession,
  GenerateOutput,
  GenerateRequestPayload,
  HistoryItem,
  GenerationProgress,
  Box,
} from "./lib/types";
import { newDraft } from "./lib/workspace";
import Canvas from "./components/Canvas";
import HistoryPanel from "./components/HistoryPanel";
import { StrictMode } from "react";
import { queuedGeneration } from "./app/generation";

const dom = new Window({ url: "http://localhost:5173" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(dom, "matchMedia", {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});
let initial: Draft | WorkspaceSession | null = null;
let submitted: GenerateRequestPayload | null = null;
let submissions: GenerateRequestPayload[] = [];
let savedItem: HistoryItem | null = null;
let finish: (out: GenerateOutput) => void = () => {};
let failGeneration: (error: Error) => void = () => {};
let failHistory = false;
let historyItems: HistoryItem[] = [];
let deletedIds: string[] = [];
let failedDeletes = new Set<string>();
let draftWrites: (Draft | WorkspaceSession)[] = [];
let exportPath = "";
let reportProgress: (progress: GenerationProgress) => void = () => {};
let closeHandler: (event: {
  preventDefault: () => void;
}) => Promise<void> = async () => {};
let destroyed = false;
const output: GenerateOutput = {
  provider: "bfl",
  model: "flux-3-image",
  finalPrompt: "original request",
  images: [
    { dataUrl: "data:image/png;base64,cmVzdWx0", mediaType: "image/png" },
  ],
  usage: { cost: 0.0205 },
  notes: ["provider note"],
};
mock.module("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
mock.module("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: typeof closeHandler) => {
      closeHandler = handler;
      return () => {};
    },
    destroy: async () => {
      destroyed = true;
    },
  }),
}));
mock.module("@tauri-apps/plugin-dialog", () => ({
  open: async (options: { directory?: boolean }) =>
    options.directory ? "D:\\Pictures\\LutriUI" : ["first.png", "second.png"],
  save: async (options: { defaultPath: string }) => {
    exportPath = options.defaultPath;
    return null;
  },
}));
mock.module("./lib/image", () => ({
  imageSize: async () => ({ width: 768, height: 768 }),
  makeThumb: async () => "thumb",
  downscaleDataUrl: async (s: string) => s,
}));
mock.module("./lib/api", () => ({
  isDesktop: () => true,
  AppError: class extends Error {},
  providerStatus: async () => ({
    bfl: true,
    openrouter: true,
    comfy: true,
    runware: true,
  }),
  draftLoad: async () => initial,
  draftSave: async (d: Draft | WorkspaceSession) => {
    draftWrites.push(d);
  },
  historyList: async () => historyItems,
  generate: (
    request: GenerateRequestPayload,
    onProgress?: typeof reportProgress,
  ) => {
    submitted = request;
    submissions.push(request);
    reportProgress = onProgress ?? (() => {});
    return new Promise<GenerateOutput>((resolve, reject) => {
      finish = resolve;
      failGeneration = reject;
    });
  },
  historySave: async (
    item: HistoryItem,
    files: { kind: string; name: string; data: string }[] = [],
  ) => {
    if (failHistory) throw new Error("disk full");
    const saved = structuredClone(item);
    const path = (file: { name: string }) => `test/${item.id}/${file.name}.png`;
    saved.inputFiles.push(...files.filter((f) => f.kind === "input").map(path));
    saved.resultFiles.push(
      ...files.filter((f) => f.kind === "result").map(path),
    );
    const mask = files.find((f) => f.kind === "mask");
    if (mask) saved.maskFile = path(mask);
    if (item.status === "ok" || item.status === "partial") savedItem = saved;
    historyItems = [...historyItems.filter((it) => it.id !== item.id), saved];
    return saved;
  },
  importImage: async (path: string) => ({
    dataUrl: "data:image/png;base64," + path,
    name: path,
    width: path.includes("first") ? 1200 : 600,
    height: 800,
  }),
  clipboardImage: async () => ({
    dataUrl: "data:image/png;base64,YQ==",
    name: "clip",
    width: 512,
    height: 512,
  }),
  copyImage: async () => {},
  historyStorage: async () => "test-only",
  assetUrl: (s: string) => s,
  historyDelete: async (id: string) => {
    if (failedDeletes.has(id)) throw new Error("file locked");
    deletedIds.push(id);
    historyItems = historyItems.filter((it) => it.id !== id);
  },
  saveDataUrl: async () => {},
  importUrl: async () => {},
  credentialSave: async () => {},
  credentialRemove: async () => {},
  credentialCheck: async () => "verified",
  credentialConfigure: async () => {},
}));
const { render, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react");
const { default: App } = await import("./App");
beforeEach(() => {
  initial = null;
  submitted = null;
  submissions = [];
  savedItem = null;
  failHistory = false;
  historyItems = [];
  deletedIds = [];
  failedDeletes = new Set();
  draftWrites = [];
  exportPath = "";
  reportProgress = () => {};
  destroyed = false;
  dom.localStorage.clear();
});
afterEach(cleanup);

test("right drag creates a FLUX box over existing boxes and handles; left drag only edits", () => {
  const box: Box = {
    uid: "existing",
    id: "obj_1",
    role: "place",
    rect: { x: 100, y: 100, w: 200, h: 200 },
    desc: "existing subject",
  };
  for (const [button, x, y, operation] of [
    [2, 150, 150, "create"],
    [2, 100, 100, "create"],
    [2, 400, 400, "create"],
    [0, 150, 150, "move"],
    [0, 100, 100, "resize"],
    [0, 400, 400, "none"],
    [1, 150, 150, "none"],
    [0, 150, 150, "pan"],
  ] as const) {
    let changed: Box[] = [box];
    const ui = render(
      <Canvas
        image={null}
        phantom={{ w: 1024, h: 1024 }}
        boxes={[box]}
        selectedId={box.id}
        tool="box"
        onSelect={() => {}}
        onChange={(boxes) => {
          changed = boxes;
        }}
      />,
    );
    const surface = ui.container.querySelector(".canvas-surface")!;
    Object.defineProperty(surface, "setPointerCapture", { value: () => {} });
    if (operation === "pan") fireEvent.keyDown(window, { code: "Space" });
    fireEvent.pointerDown(surface, {
      button,
      pointerId: 1,
      clientX: x,
      clientY: y,
    });
    if (operation === "pan")
      expect((surface as HTMLElement).style.cursor).toBe("grabbing");
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      clientX: x + 30,
      clientY: y + 40,
    });
    fireEvent.pointerUp(surface, { button, pointerId: 1 });
    if (operation === "pan") fireEvent.keyUp(window, { code: "Space" });
    if (operation === "create") {
      expect(changed).toHaveLength(2);
      expect(changed[0]).toEqual(box);
      expect(changed[1].rect).toEqual({ x, y, w: 30, h: 40 });
    } else if (operation === "move") {
      expect(changed).toHaveLength(1);
      expect(changed[0].rect).toEqual({ x: 130, y: 140, w: 200, h: 200 });
    } else if (operation === "resize") {
      expect(changed).toHaveLength(1);
      expect(changed[0].rect).toEqual({ x: 130, y: 140, w: 170, h: 160 });
    } else expect(changed).toEqual([box]);
    ui.unmount();
  }
});

test("right drag redraws a source region and read-only canvases cannot create boxes", () => {
  for (const readOnly of [false, true]) {
    const create = mock(() => {});
    const change = mock(() => {});
    const ui = render(
      <Canvas
        image={null}
        phantom={{ w: 1024, h: 1024 }}
        boxes={[]}
        selectedId={null}
        tool="box"
        readOnly={readOnly}
        onSelect={() => {}}
        onChange={change}
        onCreateRect={create}
      />,
    );
    const surface = ui.container.querySelector(".canvas-surface")!;
    Object.defineProperty(surface, "setPointerCapture", { value: () => {} });
    fireEvent.pointerDown(surface, {
      button: 2,
      pointerId: 1,
      clientX: 50,
      clientY: 60,
    });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 90, clientY: 110 });
    fireEvent.pointerUp(surface, { button: 2, pointerId: 1 });
    if (readOnly) expect(create).not.toHaveBeenCalled();
    else expect(create).toHaveBeenCalledWith({ x: 50, y: 60, w: 40, h: 50 });
    expect(change).not.toHaveBeenCalled();
    ui.unmount();
  }
});

test("history keeps multiple results and restores the GPT mask into its own workspace", async () => {
  const draft = {
    ...newDraft(undefined, "gpt"),
    provider: "comfy" as const,
    intent: "edit" as const,
    prompt: "masked edit",
    refs: [],
    mask: null,
  };
  const { refs: _, mask: __, ...recipe } = draft;
  historyItems = [
    {
      id: "masked-history",
      createdAt: 1,
      provider: "comfy",
      model: "openai/gpt-image-2.5-flare",
      mode: "edit",
      prompt: "masked edit",
      finalPrompt: "masked edit",
      params: draft.params,
      boxes: [],
      canvasWidth: 1024,
      canvasHeight: 1024,
      inputFiles: ["first.png"],
      resultFiles: ["result.png", "second.webp"],
      maskFile: "first-mask.png",
      thumb: null,
      usage: { credits: 50 },
      cost: null,
      status: "ok",
      recipe: {
        ...recipe,
        refNames: ["base"],
        refIds: ["first"],
        maskName: "local mask",
      },
    },
  ];
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: "历史" }));
  fireEvent.click(ui.getByText("masked edit"));
  fireEvent.click(ui.getByRole("button", { name: "历史结果 2" }));
  fireEvent.click(ui.getByRole("button", { name: /另存为/ }));
  await waitFor(() => expect(exportPath).toEndWith("-2.webp"));
  fireEvent.click(ui.getByRole("button", { name: "恢复完整方案" }));
  await waitFor(() =>
    expect(
      ui
        .getByRole("tab", { name: "GPT Image 2.5" })
        .getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(
    ui.getByRole("img", { name: "编辑蒙版" }).getAttribute("src"),
  ).toContain("first-mask.png");
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("masked edit");
  expect(
    ui.getByRole("button", { name: "移除蒙版" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("family workspaces keep independent drafts and persist across restart", async () => {
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("tab", { name: "GPT Image 2.5" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "FLUX layout" },
  });
  fireEvent.click(ui.getByRole("tab", { name: "GPT Image 2.5" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("");
  expect(ui.queryByRole("button", { name: "画框" })).toBeNull();
  expect(
    ui.getByRole("combobox", { name: "提供商" }).textContent,
  ).not.toContain("BFL");
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "GPT edit" },
  });
  fireEvent.click(ui.getByRole("tab", { name: "Qwen Image" }));
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "Qwen typography" },
  });
  expect(
    ui.getByRole("textbox", { name: "提示词" }).closest("aside"),
  ).not.toBeNull();
  expect(ui.queryByText("已恢复上次方案")).toBeNull();
  fireEvent.click(ui.getByRole("tab", { name: "FLUX.3 Image" }));
  expect(ui.queryByRole("button", { name: "画框" })).toBeNull();
  expect(ui.queryByRole("button", { name: "平移" })).toBeNull();
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("FLUX layout");
  await waitFor(() => expect(draftWrites.length).toBeGreaterThan(0));
  initial = draftWrites.at(-1)!;
  expect((initial as WorkspaceSession).workspaces.gpt?.prompt).toBe("GPT edit");
  ui.unmount();
  const restarted = render(<App />);
  await waitFor(() =>
    expect(
      restarted.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(restarted.getByRole("tab", { name: "Qwen Image" }));
  expect(
    (restarted.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Qwen typography");
});

test("GPT native parameters are sent and all results can be selected and exported", async () => {
  initial = {
    ...newDraft(undefined, "gpt"),
    provider: "comfy",
    prompt: "Create a transparent icon",
    params: {
      quality: "high",
      size: "1024x1024",
      background: "transparent",
      outputFormat: "png",
      moderation: "auto",
      count: 2,
    },
  };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: /^生成图像 · 约 .*Credits/ }));
  await waitFor(() => expect(submitted).not.toBeNull());
  expect(submitted!.model).toBe("gpt-image-2.5-flare");
  expect(submitted!.params.size).toBe("1024x1024");
  expect(submitted!.params.count).toBe(1);
  expect(submitted!.params.resolution).toBeUndefined();
  await act(async () =>
    finish({
      ...output,
      provider: "comfy",
      model: "openai/gpt-image-2.5-flare",
      usage: { credits: 123 },
      images: [
        output.images[0],
        { dataUrl: "data:image/webp;base64,c2Vjb25k", mediaType: "image/webp" },
      ],
    }),
  );
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "查看结果 2" })).toBeTruthy(),
  );
  fireEvent.click(ui.getByRole("button", { name: "查看结果 2" }));
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "查看结果 2" }).className).toContain(
      "active",
    ),
  );
  expect(ui.getByText(/123 Credits/)).toBeTruthy();
  expect(savedItem!.cost).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: "另存为" }));
  await waitFor(() => expect(exportPath).toEndWith("-2.webp"));
});

test("background generation belongs to its family without replacing the new workspace", async () => {
  initial = { ...newDraft(undefined, "gpt"), prompt: "Generate old GPT work" };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: "生成图像 · 1 张" }));
  await waitFor(() => expect(submitted).not.toBeNull());
  fireEvent.click(ui.getByRole("tab", { name: "Qwen Image" }));
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "New Qwen work" },
  });
  await act(async () =>
    finish({
      ...output,
      provider: "openrouter",
      model: "openai/gpt-image-2.5-flare",
    }),
  );
  await waitFor(() => expect(savedItem).not.toBeNull());
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("New Qwen work");
  expect(savedItem!.recipe!.family).toBe("gpt");
  expect(ui.queryByRole("button", { name: "查看结果 1" })).toBeNull();
  fireEvent.click(ui.getByRole("tab", { name: "GPT Image 2.5" }));
  expect(ui.getByRole("button", { name: "查看结果 1" })).toBeTruthy();
});

test("chosen export directory persists across app restart", async () => {
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  await act(async () => {
    fireEvent.click(ui.getAllByRole("button", { name: "设置" })[0]);
  });
  await act(async () => {
    fireEvent.click(ui.getByRole("button", { name: "存储" }));
  });
  await act(async () => {
    fireEvent.click(ui.getByRole("button", { name: "选择文件夹" }));
  });
  await waitFor(() =>
    expect(
      JSON.parse(dom.localStorage.getItem("lutriui-preferences-v2")!)
        .saveDirectory,
    ).toBe("D:\\Pictures\\LutriUI"),
  );
  ui.unmount();
  const restarted = render(<App />);
  await waitFor(() =>
    expect(
      restarted.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  await act(async () => {
    fireEvent.click(restarted.getAllByRole("button", { name: "设置" })[0]);
  });
  fireEvent.click(restarted.getByRole("button", { name: "存储" }));
  expect(restarted.getByText("D:\\Pictures\\LutriUI")).toBeTruthy();
});

test("invalid saved draft is preserved until explicit new scheme", async () => {
  initial = { ...newDraft(), schema: 999 } as unknown as Draft;
  const ui = render(<App />);
  await waitFor(() =>
    expect(ui.getByText(/已暂停保存以保留原文件/)).toBeTruthy(),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  expect(draftWrites).toHaveLength(0);
  fireEvent.click(ui.getByRole("button", { name: "新建" }));
  await waitFor(() => expect(draftWrites.length).toBeGreaterThan(0));
});

test("history restores all references, provider and compression; undo recovers current work", async () => {
  dom.localStorage.setItem(
    "lutriui-preferences-v2",
    JSON.stringify({ saveDirectory: "D:\\Pictures\\LutriUI" }),
  );
  initial = { ...newDraft(), prompt: "current work" };
  const recipe = {
    ...newDraft(),
    provider: "bfl" as const,
    prompt: "saved two reference edit",
    compressEnabled: false,
    maxInputEdge: 4096,
    baseId: "second",
    refNames: ["base", "detail"],
    refIds: ["first", "second"],
  };
  historyItems = [
    {
      id: "saved",
      createdAt: 1,
      provider: "bfl",
      model: "flux-3-image",
      mode: "edit",
      prompt: recipe.prompt,
      finalPrompt: recipe.prompt,
      params: { ...recipe.params },
      boxes: [],
      canvasWidth: 1024,
      canvasHeight: 1024,
      inputFiles: ["first.png", "second.png"],
      resultFiles: ["result.webp"],
      thumb: null,
      usage: {},
      cost: null,
      status: "ok",
      recipe,
    },
  ];
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: "历史" }));
  fireEvent.click(ui.getByText(recipe.prompt));
  fireEvent.click(ui.getByRole("button", { name: /另存为/ }));
  await waitFor(() =>
    expect(exportPath).toBe("D:\\Pictures\\LutriUI\\lutriui-saved.webp"),
  );
  fireEvent.click(ui.getByRole("button", { name: "恢复完整方案" }));
  await waitFor(() =>
    expect(ui.getByRole("heading", { name: /素材\s*2\/10/ })).toBeTruthy(),
  );
  expect(
    (ui.getByRole("combobox", { name: "提供商" }) as HTMLSelectElement).value,
  ).toBe("bfl");
  fireEvent.click(ui.getByText("输入与请求"));
  expect(
    (
      ui.getByRole("checkbox", {
        name: "发送前等比缩小参考图",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(
    (ui.getByRole("spinbutton", { name: "长边上限（px）" }) as HTMLInputElement)
      .value,
  ).toBe("4096");
  fireEvent.click(ui.getByRole("button", { name: "撤销 Ctrl+Z" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("current work");
  expect(ui.getByRole("heading", { name: /素材\s*0\/10/ })).toBeTruthy();
});

test("multi-file import leaves output canvas and existing boxes intact", async () => {
  initial = {
    ...newDraft(),
    prompt: "existing layout",
    boxes: [
      {
        uid: "stable",
        id: "obj_1",
        role: "place",
        rect: { x: 1, y: 1, w: 20, h: 20 },
        desc: "tree",
      },
    ],
  };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: "添加文件" }));
  await waitFor(() =>
    expect(ui.getByRole("heading", { name: /素材\s*2\/10/ })).toBeTruthy(),
  );
  expect(ui.getByText("区域 · 1")).toBeTruthy();
  expect(ui.getByText("first.png")).toBeTruthy();
  expect(ui.getByText("second.png")).toBeTruthy();
  expect(ui.getAllByText("1024×1024").length).toBeGreaterThan(0);
});
test("in-flight snapshot is immutable; result does not overwrite newer draft or references", async () => {
  dom.localStorage.setItem(
    "lutriui-preferences-v2",
    JSON.stringify({ saveDirectory: "D:\\Pictures\\LutriUI\\" }),
  );
  initial = {
    ...newDraft(),
    provider: "bfl",
    prompt: "original prompt",
    refs: [
      {
        uid: "a",
        dataUrl: "data:image/png;base64,YQ==",
        width: 512,
        height: 512,
        name: "source",
      },
    ],
  };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    ui.getByRole("button", { name: /^((生成图像|应用编辑) ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(submitted).not.toBeNull());
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "next version while running" },
  });
  fireEvent.click(ui.getByLabelText("更多导入方式"));
  fireEvent.click(ui.getByRole("button", { name: "粘贴图片" }));
  await waitFor(() =>
    expect(ui.getByRole("heading", { name: /素材\s*2\/10/ })).toBeTruthy(),
  );
  expect(
    ui
      .getByRole("button", { name: /^((生成图像|应用编辑) ·|请求已发送$)/ })
      .hasAttribute("disabled"),
  ).toBe(false);
  await act(async () => {
    finish(output);
  });
  await waitFor(() =>
    expect(ui.getByText("已存历史", { exact: false })).toBeTruthy(),
  );
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("next version while running");
  expect(ui.getByRole("heading", { name: /素材\s*2\/10/ })).toBeTruthy();
  expect(savedItem!.prompt).toBe("original prompt");
  expect(savedItem!.recipe!.refIds).toEqual(["a"]);
  expect(submitted!.params.version).toBe("latest");
  expect(ui.getByRole("button", { name: "另存为" })).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "另存为" }));
  await waitFor(() =>
    expect(exportPath).toBe(
      "D:\\Pictures\\LutriUI\\lutriui-" + savedItem!.id.slice(0, 8) + ".png",
    ),
  );
});
test("primary roles reach the request and native progress follows the active task", async () => {
  initial = { ...newDraft(), prompt: "edit <ref_image_1> using <ref_image_0>" };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: "添加文件" }));
  await waitFor(() =>
    expect(ui.getByRole("heading", { name: /素材\s*2\/10/ })).toBeTruthy(),
  );
  fireEvent.change(ui.getByRole("combobox", { name: "素材用途 first.png" }), {
    target: { value: "style" },
  });
  fireEvent.click(ui.getByLabelText("素材操作 second.png"));
  fireEvent.click(ui.getAllByRole("button", { name: "设为编辑主图" }).at(-1)!);
  fireEvent.click(
    ui.getByRole("button", { name: /^((生成图像|应用编辑) ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(submitted).not.toBeNull());
  expect(submitted!.images[0]).toContain("second.png");
  expect(submitted!.finalPrompt).toContain(
    "edit <ref_image_0> using <ref_image_1>",
  );
  expect(submitted!.finalPrompt).toContain("visual style");
  await act(async () =>
    reportProgress({ phase: "queued", taskId: "local-job" }),
  );
  expect(ui.getByText("排队中")).toBeTruthy();
  await act(async () => closeHandler({ preventDefault: () => {} }));
  expect(ui.getByRole("dialog", { name: "关闭应用" })).toBeTruthy();
  expect(destroyed).toBe(false);
  fireEvent.click(ui.getByRole("button", { name: "继续等待" }));
  await act(async () => reportProgress({ phase: "downloading" }));
  expect(ui.getByText("下载结果")).toBeTruthy();
  await act(async () => finish(output));
  await waitFor(() =>
    expect(savedItem?.recipe?.refPurposes).toEqual([undefined, "style"]),
  );
});

test("family default model and parameters apply only to new work", async () => {
  initial = { ...newDraft(), prompt: "keep this draft" };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getAllByRole("button", { name: "设置" })[0]);
  fireEvent.click(ui.getByRole("button", { name: "新建默认值" }));
  fireEvent.click(ui.getByRole("button", { name: "GPT Image 2.5" }));
  fireEvent.change(ui.getByRole("combobox", { name: "默认模型" }), {
    target: { value: "gpt-image-2.5-sunburst" },
  });
  fireEvent.click(ui.getByRole("button", { name: "关闭" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("keep this draft");
  fireEvent.click(ui.getByRole("tab", { name: "GPT Image 2.5" }));
  expect(
    (ui.getByRole("combobox", { name: "模型版本" }) as HTMLSelectElement).value,
  ).toBe("gpt-image-2.5-sunburst");
  expect(
    (ui.getByRole("spinbutton", { name: "生成张数" }) as HTMLInputElement)
      .value,
  ).toBe("1");
});

test("continuing an edit replaces the primary, retains reference roles, and starts a new instruction", async () => {
  initial = {
    ...newDraft(),
    intent: "edit",
    baseId: "main",
    prompt: "old <ref_image_1> instruction",
    refs: [
      {
        uid: "main",
        name: "main",
        width: 512,
        height: 512,
        dataUrl: "data:image/png;base64,bWFpbg==",
      },
      {
        uid: "style",
        name: "style",
        width: 512,
        height: 512,
        dataUrl: "data:image/png;base64,c3R5bGU=",
        purpose: "style",
      },
    ],
  };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    ui.getByRole("button", { name: /^((生成图像|应用编辑) ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(submitted).not.toBeNull());
  await act(async () => finish(output));
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "继续编辑" })).toBeTruthy(),
  );
  fireEvent.click(ui.getByRole("button", { name: "继续编辑" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("");
  expect(
    (ui.getByRole("combobox", { name: "素材用途 style" }) as HTMLSelectElement)
      .value,
  ).toBe("style");
  expect(ui.getByRole("heading", { name: /素材\s*2\/10/ })).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "撤销 Ctrl+Z" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("old <ref_image_1> instruction");
});

test("inactive route parameters do not change generation labels or the saved request record", async () => {
  initial = {
    ...newDraft(),
    provider: "bfl",
    prompt: "one image",
    params: { ...newDraft().params, count: 20 },
  };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui
        .getByRole("button", { name: "生成图像 · 1 张" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: "生成图像 · 1 张" }));
  await waitFor(() => expect(submitted).not.toBeNull());
  expect(submitted!.params.count).toBeUndefined();
  await act(async () => finish(output));
  await waitFor(() => expect(savedItem).not.toBeNull());
  expect(savedItem!.params.count).toBeUndefined();
  expect(savedItem!.recipe?.params.count).toBe(20);
});

test("route changes undo within a task; task navigation preserves independent drafts", async () => {
  initial = {
    ...newDraft(undefined, "qwen"),
    provider: "runware",
    prompt: "a poster",
  };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.change(ui.getByRole("combobox", { name: "种子模式" }), {
    target: { value: "fixed" },
  });
  fireEvent.change(ui.getByRole("spinbutton", { name: "种子值" }), {
    target: { value: "20" },
  });
  fireEvent.change(ui.getByRole("combobox", { name: "提供商" }), {
    target: { value: "openrouter" },
  });
  fireEvent.click(ui.getByRole("button", { name: "撤销 Ctrl+Z" }));
  expect(
    (ui.getByRole("combobox", { name: "提供商" }) as HTMLSelectElement).value,
  ).toBe("runware");
  expect(
    (ui.getByRole("spinbutton", { name: "种子值" }) as HTMLInputElement).value,
  ).toBe("20");
  fireEvent.click(ui.getByRole("button", { name: "编辑" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("");
  expect(
    ui.getByRole("button", { name: "撤销 Ctrl+Z" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "edit separately" },
  });
  fireEvent.click(ui.getByRole("button", { name: "生成" }));
  expect(
    ui.getByRole("button", { name: "生成" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("a poster");
  fireEvent.click(ui.getByRole("button", { name: "编辑" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("edit separately");
});

test("generation and editing keep independent inputs, parameters and undo across restart", async () => {
  initial = { ...newDraft(undefined, "gpt"), prompt: "new scene" };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: "编辑" }));
  expect(ui.getByRole("button", { name: "添加编辑主图" })).toBeTruthy();
  expect(
    ui.getByRole("button", { name: /^应用编辑 ·/ }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(ui.getByRole("button", { name: "添加编辑主图" }));
  await waitFor(() =>
    expect(ui.queryByRole("button", { name: "添加编辑主图" })).toBeNull(),
  );
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "change the light" },
  });
  fireEvent.change(ui.getByRole("combobox", { name: "生成质量" }), {
    target: { value: "high" },
  });
  fireEvent.click(ui.getByRole("button", { name: "生成" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("new scene");
  expect(ui.queryByAltText("来源参考图")).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: "编辑" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("change the light");
  expect(
    (ui.getByRole("combobox", { name: "生成质量" }) as HTMLSelectElement).value,
  ).toBe("high");
  await waitFor(() =>
    expect(
      draftWrites.at(-1) &&
        (draftWrites.at(-1) as WorkspaceSession).taskWorkspaces?.["gpt:edit"]
          ?.prompt,
    ).toBe("change the light"),
  );
  initial = draftWrites.at(-1)!;
  ui.unmount();
  const restarted = render(<App />);
  await waitFor(() =>
    expect(
      (
        restarted.getByRole("textbox", {
          name: "提示词",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("change the light"),
  );
  fireEvent.click(restarted.getByRole("button", { name: "生成" }));
  expect(
    (restarted.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement)
      .value,
  ).toBe("new scene");
});

test("a background generation stays in its task and starts editing without replacing generation", async () => {
  initial = { ...newDraft(undefined, "gpt"), prompt: "draw a garden" };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(submitted).not.toBeNull());
  fireEvent.click(ui.getByRole("button", { name: "编辑" }));
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "separate edit" },
  });
  await act(async () =>
    finish({ ...output, model: "openai/gpt-image-2.5-flare" }),
  );
  expect(ui.queryByRole("button", { name: "查看结果 1" })).toBeNull();
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("separate edit");
  fireEvent.click(ui.getByRole("button", { name: "生成" }));
  expect(ui.getByRole("button", { name: "用这张图开始编辑" })).toBeTruthy();
  expect(ui.queryByRole("button", { name: "对照" })).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: "用这张图开始编辑" }));
  expect(
    ui.getByRole("button", { name: "编辑" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(ui.queryByRole("button", { name: "添加编辑主图" })).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: "撤销 Ctrl+Z" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("separate edit");
  fireEvent.click(ui.getByRole("button", { name: "生成" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("draw a garden");
  fireEvent.click(
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(ui.getByText("等待结果")).toBeTruthy());
  await act(async () =>
    finish({ ...output, model: "openai/gpt-image-2.5-flare" }),
  );
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "查看尝试 2" })).toBeTruthy(),
  );
  fireEvent.click(ui.getByRole("button", { name: "查看尝试 1" }));
  expect(ui.getByRole("button", { name: "查看尝试 1" }).className).toContain(
    "active",
  );
  expect(ui.queryByRole("button", { name: "对照" })).toBeNull();
});

test("queue saves requests immediately, cancels waiting work and runs FIFO snapshots", async () => {
  initial = { ...newDraft(), prompt: "first scene" };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui
        .getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(submissions).toHaveLength(1));
  const firstId = historyItems.find((it) => it.prompt === "first scene")!.id;
  expect(historyItems[0].status).toBe("running");
  expect(submissions[0].requestId).toBe(firstId);
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "second scene" },
  });
  fireEvent.click(
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ }),
  );
  await waitFor(() =>
    expect(
      historyItems.find((it) => it.prompt === "second scene")?.status,
    ).toBe("queued"),
  );
  expect(submissions).toHaveLength(1);
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "third scene" },
  });
  fireEvent.click(
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(historyItems).toHaveLength(3));
  fireEvent.click(ui.getByRole("button", { name: "任务队列 · 3" }));
  fireEvent.click(ui.getAllByRole("button", { name: "取消等待" })[0]);
  await waitFor(() =>
    expect(
      historyItems.find((it) => it.prompt === "second scene")?.status,
    ).toBe("cancelled"),
  );
  fireEvent.click(ui.getByRole("button", { name: "关闭" }));
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "next unfinished draft" },
  });
  await act(async () => finish(output));
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(submissions[1].finalPrompt).toContain("third scene");
  await act(async () => finish(output));
  await waitFor(() =>
    expect(historyItems.filter((it) => it.status === "ok")).toHaveLength(2),
  );
  expect(historyItems.find((it) => it.id === firstId)?.status).toBe("ok");
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("next unfinished draft");
});

test("restoring queued work under StrictMode submits once and does not rerun interrupted tasks", async () => {
  const job = queuedGeneration({ ...newDraft(), prompt: "restore this queue" });
  historyItems = [
    job.item,
    { ...job.item, id: "interrupted-job", status: "interrupted" },
  ];
  const ui = render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => expect(submissions).toHaveLength(1));
  expect(submissions[0].requestId).toBe(job.item.id);
  await act(async () => finish(output));
  await waitFor(() => expect(savedItem?.status).toBe("ok"));
  expect(submissions).toHaveLength(1);
  expect(historyItems.find((it) => it.id === "interrupted-job")?.status).toBe(
    "interrupted",
  );
  ui.unmount();
});

test("a failed queue item does not retry and the next item still runs", async () => {
  initial = { ...newDraft(), prompt: "failed first" };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui
        .getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(submissions).toHaveLength(1));
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "successful second" },
  });
  fireEvent.click(
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(historyItems).toHaveLength(2));
  await act(async () => failGeneration(new Error("provider refused")));
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(historyItems.find((it) => it.prompt === "failed first")?.status).toBe(
    "failed",
  );
  expect(submissions[1].finalPrompt).toContain("successful second");
  await act(async () => finish(output));
  await waitFor(() => expect(savedItem?.status).toBe("ok"));
  expect(submissions).toHaveLength(2);
});

test("queue never calls a provider when the request record cannot be saved", async () => {
  initial = { ...newDraft(), prompt: "must be durable first" };
  failHistory = true;
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui
        .getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(ui.getByText(/加入队列失败/)).toBeTruthy());
  expect(submissions).toHaveLength(0);
  expect(historyItems).toHaveLength(0);
});

test("Comfy result and history omit missing charge information", async () => {
  initial = {
    ...newDraft(undefined, "qwen"),
    provider: "comfy",
    prompt: "a garden",
  };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui
        .getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(submitted).not.toBeNull());
  await act(async () =>
    finish({
      ...output,
      provider: "comfy",
      model: "qwen-image-3.0",
      usage: {},
    }),
  );
  await waitFor(() => expect(savedItem?.status).toBe("ok"));
  expect(ui.queryByText(/实际.*未/)).toBeNull();
  expect(ui.container.querySelector(".result-meta")?.textContent).not.toContain(
    "Credits",
  );
  fireEvent.click(ui.getByRole("button", { name: "历史" }));
  fireEvent.click(ui.getByText("a garden"));
  expect(ui.queryByText("成本")).toBeNull();
});

test("history failure keeps result usable and retry saves without another generation", async () => {
  initial = { ...newDraft(), prompt: "test prompt" };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    ui.getByRole("button", { name: /^((生成图像|应用编辑) ·|请求已发送$)/ }),
  );
  await waitFor(() => expect(submitted).not.toBeNull());
  const request = submitted;
  failHistory = true;
  await act(async () => {
    finish(output);
  });
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "重新保存历史" })).toBeTruthy(),
  );
  expect(ui.getByRole("button", { name: "复制图片" })).toBeTruthy();
  failHistory = false;
  fireEvent.click(ui.getByRole("button", { name: "重新保存历史" }));
  await waitFor(() => expect(savedItem).not.toBeNull());
  expect(submitted).toBe(request);
});

test("repeat count queues identical requests with independent random seeds and stable history ids", async () => {
  initial = {
    ...newDraft(undefined, "qwen"),
    provider: "comfy",
    prompt: "same scene",
    params: { seed: null, count: 4 },
  };
  const ui = render(<App />);
  const button = () =>
    ui.getByRole("button", { name: /^(生成图像 ·|请求已发送$)/ });
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false));
  const count = ui.getByRole("spinbutton", {
    name: "生成张数",
  }) as HTMLInputElement;
  expect(count.value).toBe("1");
  fireEvent.change(count, { target: { value: "2" } });
  fireEvent.click(button());
  await waitFor(() => expect(historyItems).toHaveLength(1));
  await waitFor(() => expect(submissions).toHaveLength(1));
  expect(historyItems[0].status).toBe("running");
  const batchId = historyItems[0].id;
  expect(submissions[0].params.count).toBe(1);
  const seeds = historyItems[0].batch!.requests.map((request) => request.seed);
  expect(seeds.every((seed) => Number.isInteger(seed))).toBe(true);
  expect(new Set(seeds).size).toBe(2);
  expect(
    historyItems.every((it) => it.recipe?.params.seed === it.params.seed),
  ).toBe(true);
  expect(historyItems[0].batch!.requests).toHaveLength(2);
  fireEvent.change(count, { target: { value: "1" } });
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false));
  fireEvent.click(button());
  await waitFor(() => expect(historyItems).toHaveLength(2));
  expect(submissions).toHaveLength(1);
  await act(async () => finish(output));
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(submissions[1].params.seed).toBe(seeds[1]);
  expect(submissions[1].historyId).toBe(batchId);
  expect(submissions[1].requestId).not.toBe(submissions[0].requestId);
  await act(async () => finish(output));
  await waitFor(() => expect(submissions).toHaveLength(3));
  const batch = historyItems.find((item) => item.id === batchId)!;
  expect(batch.resultFiles).toHaveLength(2);
  expect(
    batch.batch!.requests.every((request) => request.status === "ok"),
  ).toBe(true);
  expect(batch.cost).toBe(output.usage!.cost! * 2);
  fireEvent.click(ui.getByRole("button", { name: "历史" }));
  fireEvent.click(ui.getAllByText("same scene")[0]);
  expect(ui.getByRole("button", { name: "历史结果 2" })).toBeTruthy();
  expect(ui.getAllByText("提示词")).toHaveLength(1);
  await act(async () => finish(output));
  await waitFor(() =>
    expect(historyItems.every((it) => it.status === "ok")).toBe(true),
  );
  expect(
    submissions.every((req) => req.finalPrompt.includes("same scene")),
  ).toBe(true);
});

test("fixed seeds are preserved and seedless routes do not gain unsupported seeds", () => {
  const fixed = {
    ...newDraft(undefined, "qwen"),
    provider: "comfy" as const,
    prompt: "fixed",
    params: { seed: 42 },
  };
  const first = queuedGeneration(fixed),
    second = queuedGeneration(fixed);
  expect(first.item.params.seed).toBe(42);
  expect(second.item.params.seed).toBe(42);
  expect(first.item.id).not.toBe(second.item.id);
  expect(
    queuedGeneration({ ...newDraft(), prompt: "seedless" }).item.params.seed,
  ).toBeUndefined();
});

test("history quick deletion requires confirmation and cancellation keeps files", async () => {
  const item = {
    ...queuedGeneration({ ...newDraft(), prompt: "history sample" }).item,
    status: "ok",
  };
  historyItems = [item];
  let refreshed = 0;
  const ui = render(
    <HistoryPanel
      items={historyItems}
      saveDirectory=""
      onRefresh={() => refreshed++}
      onUseAsInput={() => {}}
      onRestoreEdit={() => {}}
    />,
  );
  fireEvent.click(ui.getByRole("button", { name: "删除第 1 条历史记录" }));
  expect(ui.getByRole("dialog", { name: "确认删除历史记录" })).toBeTruthy();
  expect(deletedIds).toHaveLength(0);
  fireEvent.click(ui.getByRole("button", { name: "取消" }));
  expect(deletedIds).toHaveLength(0);
  expect(ui.queryByRole("dialog")).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: "删除第 1 条历史记录" }));
  fireEvent.click(ui.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(deletedIds).toEqual([item.id]));
  await waitFor(() => expect(refreshed).toBe(1));
  expect(historyItems).toHaveLength(0);
});

test("history select all excludes active tasks and partial deletion preserves failed selections", async () => {
  const make = (id: string, status: string) => ({
    ...queuedGeneration({ ...newDraft(), prompt: id }).item,
    id,
    status,
  });
  historyItems = [
    make("done", "ok"),
    make("failed", "failed"),
    make("waiting", "queued"),
    make("running", "running"),
  ];
  failedDeletes.add("failed");
  let refreshed = 0;
  const props = {
    saveDirectory: "",
    onRefresh: () => refreshed++,
    onUseAsInput: () => {},
    onRestoreEdit: () => {},
  };
  const ui = render(<HistoryPanel {...props} items={historyItems} />);
  fireEvent.click(ui.getByRole("button", { name: "批量删除" }));
  expect(
    ui
      .getByRole("checkbox", { name: "选择第 3 条历史记录" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(ui.getByRole("button", { name: "全选" }));
  expect(ui.getByText("已选 2 条")).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "取消全选" }));
  expect(ui.getByText("已选 0 条")).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "全选" }));
  fireEvent.click(ui.getByRole("button", { name: "删除所选" }));
  expect(deletedIds).toHaveLength(0);
  fireEvent.click(ui.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(refreshed).toBe(1));
  expect(deletedIds).toEqual(["done"]);
  expect(ui.getByRole("alert").textContent).toContain("1 条记录删除失败");
  ui.rerender(<HistoryPanel {...props} items={historyItems} />);
  expect(ui.getByText("已选 1 条")).toBeTruthy();
  failedDeletes.clear();
  fireEvent.click(ui.getByRole("button", { name: "删除所选" }));
  fireEvent.click(ui.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(refreshed).toBe(2));
  expect(deletedIds).toEqual(["done", "failed"]);
  expect(historyItems.map((it) => it.id)).toEqual(["waiting", "running"]);
});

test("a partially failed batch retains its images and shared inputs in one history record", async () => {
  const base = {
    dataUrl: "data:image/png;base64,YQ==",
    name: "shared input",
    uid: "shared",
    width: 512,
    height: 512,
  };
  initial = {
    ...newDraft(undefined, "gpt"),
    provider: "comfy",
    intent: "edit",
    baseId: base.uid,
    refs: [base],
    prompt: "batch edit",
  };
  const ui = render(<App />);
  const button = () =>
    ui.getByRole("button", { name: /^(应用编辑 ·|请求已发送$)/ });
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false));
  fireEvent.change(ui.getByRole("spinbutton", { name: "生成张数" }), {
    target: { value: "3" },
  });
  fireEvent.click(button());
  await waitFor(() => expect(submissions).toHaveLength(1));
  expect(historyItems).toHaveLength(1);
  await act(async () => finish(output));
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(historyItems[0].resultFiles).toHaveLength(1);
  await act(async () => failGeneration(new Error("second failed")));
  await waitFor(() => expect(submissions).toHaveLength(3));
  expect(historyItems[0].resultFiles).toHaveLength(1);
  await act(async () => finish(output));
  await waitFor(() => expect(historyItems[0].status).toBe("partial"));
  expect(historyItems).toHaveLength(1);
  expect(historyItems[0].inputFiles).toHaveLength(1);
  expect(historyItems[0].resultFiles).toHaveLength(2);
  expect(
    historyItems[0].batch!.requests.map((request) => request.status),
  ).toEqual(["ok", "failed", "ok"]);
  expect(new Set(submissions.map((request) => request.requestId)).size).toBe(3);
  expect(new Set(submissions.map((request) => request.historyId)).size).toBe(1);
  fireEvent.click(ui.getByRole("button", { name: "历史" }));
  fireEvent.click(ui.getByText("batch edit"));
  expect(ui.getByRole("button", { name: "历史结果 2" })).toBeTruthy();
  expect(ui.getAllByRole("button", { name: /查看历史素材/ })).toHaveLength(1);
});

test("queued batch restoration reuses persisted seeds and request ids without new history records", async () => {
  const job = queuedGeneration({
    ...newDraft(undefined, "qwen"),
    provider: "comfy",
    prompt: "restore batch",
    params: { seed: 11, count: 1 },
  });
  job.item.batch = {
    requests: [
      { requestId: "batch-first", seed: 11, status: "queued" },
      { requestId: "batch-second", seed: 22, status: "queued" },
    ],
  };
  historyItems = [job.item];
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => expect(submissions).toHaveLength(1));
  expect(submissions[0].requestId).toBe("batch-first");
  expect(submissions[0].params.seed).toBe(11);
  await act(async () => finish(output));
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(submissions[1].requestId).toBe("batch-second");
  expect(submissions[1].params.seed).toBe(22);
  await act(async () => finish(output));
  await waitFor(() => expect(historyItems[0].status).toBe("ok"));
  expect(historyItems).toHaveLength(1);
  expect(historyItems[0].id).toBe(job.item.id);
  expect(historyItems[0].resultFiles).toHaveLength(2);
});
