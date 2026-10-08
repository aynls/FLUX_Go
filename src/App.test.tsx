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
  GalleryItem,
} from "./lib/types";
import { newDraft } from "./lib/workspace";
import Canvas from "./components/Canvas";
import HistoryPanel from "./components/HistoryPanel";
import GenerationInfo, { searchDocument } from "./components/GenerationInfo";
import { webUrl } from "./lib/links";
import { queuedGeneration } from "./app/generation";

const dom = new Window({ url: "http://localhost:5173" });
Object.defineProperty(dom.navigator, "language", { get: () => "zh-CN" });
Object.defineProperty(dom.navigator, "languages", { get: () => ["zh-CN"] });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  DOMParser: dom.DOMParser,
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
let completions: {
  finish: (out: GenerateOutput) => void;
  fail: (error: Error) => void;
  progress: typeof reportProgress;
}[] = [];
let finish: (out: GenerateOutput) => void = () => {};
let historyItems: HistoryItem[] = [];
let galleryItems: GalleryItem[] = [];
let deletedIds: string[] = [];
let failedDeletes = new Set<string>();
let draftWrites: (Draft | WorkspaceSession)[] = [];
let exportPath = "";
let reportProgress: (progress: GenerationProgress) => void = () => {};
let closeHandler: (event: {
  preventDefault: () => void;
}) => Promise<void> = async () => {};
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
    destroy: async () => {},
    setTitle: async () => {},
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
    google: true,
    ark: true,
    byteplus: true,
    xai: true,
  }),
  draftLoad: async () =>
    initial && "tasks" in initial
      ? initial
      : initial
        ? {
            schema: 2,
            activeIntent: initial.intent,
            tasks: { [initial.intent]: initial },
          }
        : null,
  draftSave: async (d: Draft | WorkspaceSession) => {
    draftWrites.push(d);
  },
  historyList: async () => historyItems,
  galleryList: async () => galleryItems,
  galleryImport: async (
    image: { name: string; width: number; height: number },
    source: GalleryItem["source"],
  ) => {
    const item: GalleryItem = {
      ...image,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      mime: "image/png",
      source,
      historyId: null,
      model: null,
      provider: null,
      filePath: "owned/original.png",
      thumbPath: "owned/thumb.png",
      pendingDelete: false,
    };
    galleryItems = [...galleryItems, item];
    return item;
  },
  galleryRead: async (id: string) => {
    const item = galleryItems.find((i) => i.id === id);
    if (!item) throw new Error("图片已从图库删除");
    return { ...item, assetId: id, dataUrl: "data:image/png;base64," + id };
  },
  galleryDelete: async (id: string) => {
    if (failedDeletes.has(id)) throw new Error("file locked");
    deletedIds.push(id);
    galleryItems = galleryItems.filter((item) => item.id !== id);
  },
  generate: (
    request: GenerateRequestPayload,
    onProgress?: typeof reportProgress,
  ) => {
    submitted = request;
    submissions.push(request);
    reportProgress = onProgress ?? (() => {});
    return new Promise<GenerateOutput>((resolve, reject) => {
      completions.push({
        finish: resolve,
        fail: reject,
        progress: onProgress ?? (() => {}),
      });
      finish = resolve;
    });
  },
  historySave: async (
    item: HistoryItem,
    files: { kind: string; name: string; data: string }[] = [],
  ) => {
    const saved = structuredClone(item);
    const path = (file: { name: string }) => `test/${item.id}/${file.name}.png`;
    saved.inputFiles = [
      ...new Set([
        ...saved.inputFiles,
        ...files.filter((f) => f.kind === "input").map(path),
      ]),
    ];
    saved.resultFiles = [
      ...new Set([
        ...saved.resultFiles,
        ...files.filter((f) => f.kind === "result").map(path),
      ]),
    ];
    const mask = files.find((f) => f.kind === "mask");
    if (mask) saved.maskFile = path(mask);
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
  completions = [];
  historyItems = [];
  galleryItems = [];
  deletedIds = [];
  failedDeletes = new Set();
  draftWrites = [];
  exportPath = "";
  reportProgress = () => {};
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

test("a non-primary reference source region can be edited, cancelled, applied and undone independently of its target", async () => {
  const d: Draft = {
    ...newDraft(),
    provider: "runware",
    intent: "edit",
    baseId: "main",
    prompt: "Move <star>",
    canvas: { w: 1000, h: 500 },
    refs: [
      {
        uid: "main",
        name: "main",
        dataUrl: "data:image/png;base64,bWFpbg==",
        width: 1000,
        height: 500,
      },
      {
        uid: "source",
        name: "source portrait",
        dataUrl: "data:image/png;base64,c291cmNl",
        width: 500,
        height: 1000,
      },
    ],
    boxes: [
      {
        uid: "star-uid",
        id: "star",
        desc: "a star",
        role: "move",
        sourceId: "source",
        rect: { x: 500, y: 0, w: 500, h: 250 },
        srcRect: { x: 0, y: 500, w: 250, h: 500 },
      },
    ],
  };
  initial = d;
  let ui!: ReturnType<typeof render>;
  await act(async () => {
    ui = render(<App />);
  });
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "展开 star" })).toBeTruthy(),
  );
  fireEvent.click(ui.getByRole("button", { name: "展开 star" }));
  fireEvent.click(ui.getByRole("button", { name: "在参考图上框选" }));
  const dialog = ui.getByRole("dialog", { name: "来源区域 · star" });
  expect(dialog.textContent).toContain("source portrait · 500×1000");
  const sourceCanvas = dialog.querySelector(".canvas-surface")!;
  Object.defineProperty(sourceCanvas, "setPointerCapture", { value: () => {} });
  fireEvent.pointerDown(sourceCanvas, {
    button: 2,
    pointerId: 1,
    clientX: 50,
    clientY: 60,
  });
  fireEvent.pointerMove(sourceCanvas, {
    pointerId: 1,
    clientX: 150,
    clientY: 260,
  });
  fireEvent.pointerUp(sourceCanvas, { button: 2, pointerId: 1 });
  expect(
    (
      dialog.querySelector(
        'input[aria-label="来源区域 · 0–1000 左"]',
      ) as HTMLInputElement
    ).value,
  ).toBe("100");
  expect(
    (
      dialog.querySelector(
        'input[aria-label="来源区域 · 0–1000 下"]',
      ) as HTMLInputElement
    ).value,
  ).toBe("260");
  const left = dialog.querySelector(
    'input[aria-label="来源区域 · 0–1000 左"]',
  )!;
  fireEvent.change(left, { target: { value: "600" } });
  fireEvent.blur(left);
  expect(
    ui.getByRole("button", { name: "应用来源区域" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(left, { target: { value: "200" } });
  fireEvent.blur(left);
  fireEvent.click(ui.getByRole("button", { name: "取消" }));
  fireEvent.click(ui.getByRole("button", { name: "在参考图上框选" }));
  const reopened = ui.getByRole("dialog", { name: "来源区域 · star" });
  expect(
    (
      reopened.querySelector(
        'input[aria-label="来源区域 · 0–1000 左"]',
      ) as HTMLInputElement
    ).value,
  ).toBe("0");
  for (const [name, value] of [
    ["上", "100"],
    ["左", "200"],
    ["下", "500"],
    ["右", "800"],
  ]) {
    fireEvent.change(
      reopened.querySelector(`input[aria-label="来源区域 · 0–1000 ${name}"]`)!,
      { target: { value } },
    );
  }
  fireEvent.blur(
    reopened.querySelector('input[aria-label="来源区域 · 0–1000 右"]')!,
  );
  fireEvent.click(ui.getByRole("button", { name: "应用来源区域" }));
  fireEvent.click(ui.getByRole("button", { name: /^应用编辑 ·/ }));
  await waitFor(() => expect(submitted).not.toBeNull());
  expect(submitted!.regions).toEqual([
    {
      id: "star",
      description: "a star",
      referenceIndex: 1,
      sourceBox: [100, 200, 500, 800],
      targetBox: [0, 500, 500, 1000],
    },
  ]);
  fireEvent.click(ui.getByRole("button", { name: "撤销 Ctrl+Z" }));
  fireEvent.click(ui.getByRole("button", { name: "展开 star" }));
  expect(
    (
      ui.getByRole("spinbutton", {
        name: "来源区域 · 0–1000 左",
      }) as HTMLInputElement
    ).value,
  ).toBe("0");
  await act(async () => finish(output));
});

test("new image families expose official routes, color icons and independent route settings with shared task content", async () => {
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("combobox", { name: "模型系列" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("combobox", { name: "模型系列" }));
  fireEvent.click(ui.getByRole("option", { name: "Gemini Image" }));
  expect(
    ui.container
      .querySelector(".model-family-control img")
      ?.getAttribute("src"),
  ).toBe("/nano-banana.png");
  expect(
    ui.container.querySelector(".model-family-control img")?.className,
  ).not.toContain("monochrome");
  fireEvent.change(ui.getByRole("combobox", { name: "分辨率档位" }), {
    target: { value: "512" },
  });
  fireEvent.change(ui.getByRole("combobox", { name: "模型版本" }), {
    target: { value: "gemini-nano-banana-2.1" },
  });
  expect(ui.getByRole("status").textContent).toContain("512 → 1K");
  expect(
    Array.from(
      ui.getByRole("combobox", { name: "提供商" }).querySelectorAll("option"),
    ).map((option) => option.value),
  ).toEqual(["openrouter", "comfy", "runware", "google"]);
  expect(
    ui
      .getByRole("combobox", { name: "分辨率档位" })
      .querySelector('option[value="512"]'),
  ).toBeNull();
  fireEvent.change(ui.getByRole("combobox", { name: "提供商" }), {
    target: { value: "google" },
  });
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "Google image" },
  });
  expect(ui.queryByRole("combobox", { name: "输出格式" })).toBeNull();
  fireEvent.click(ui.getByRole("combobox", { name: "模型系列" }));
  fireEvent.click(ui.getByRole("option", { name: "Seedream" }));
  expect(
    ui.container
      .querySelector(".model-family-control img")
      ?.getAttribute("src"),
  ).toBe("/seeddream.png");
  const provider = ui.getByRole("combobox", { name: "提供商" });
  expect(provider.querySelector('option[value="ark"]')).not.toBeNull();
  expect(provider.querySelector('option[value="byteplus"]')).not.toBeNull();
  fireEvent.change(provider, { target: { value: "byteplus" } });
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "BytePlus image" },
  });
  await waitFor(() =>
    expect((draftWrites.at(-1) as WorkspaceSession)?.tasks.create?.prompt).toBe(
      "BytePlus image",
    ),
  );
  initial = draftWrites.at(-1)!;
  ui.unmount();
  const restarted = render(<App />);
  await waitFor(() =>
    expect(
      (restarted.getByRole("combobox", { name: "提供商" }) as HTMLSelectElement)
        .value,
    ).toBe("byteplus"),
  );
  expect(
    (restarted.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement)
      .value,
  ).toBe("BytePlus image");
  fireEvent.click(restarted.getByRole("combobox", { name: "模型系列" }));
  fireEvent.click(restarted.getByRole("option", { name: "Gemini Image" }));
  expect(
    (restarted.getByRole("combobox", { name: "模型版本" }) as HTMLSelectElement)
      .value,
  ).toBe("gemini-nano-banana-2.1");
  expect(
    (restarted.getByRole("combobox", { name: "提供商" }) as HTMLSelectElement)
      .value,
  ).toBe("google");
  expect(
    (restarted.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement)
      .value,
  ).toBe("BytePlus image");
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
        (draftWrites.at(-1) as WorkspaceSession).tasks.edit?.prompt,
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
}, 10000);

test("all images in a batch are submitted before any finish and simultaneous results are retained", async () => {
  initial = { ...newDraft(), prompt: "parallel candidates", repeatCount: 4 };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: /^生成图像 ·/ }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: /^生成图像 ·/ }));
  await waitFor(() => expect(submissions).toHaveLength(4));
  expect(historyItems).toHaveLength(1);
  expect(historyItems[0].batch?.requests.map((r) => r.status)).toEqual(
    Array(4).fill("running"),
  );
  expect(new Set(submissions.map((request) => request.requestId)).size).toBe(4);
  expect(ui.queryByRole("button", { name: "停止后续生成" })).toBeNull();
  const images = completions.map(
    (_, i) => `data:image/png;base64,${btoa("candidate " + i)}`,
  );
  await act(async () => {
    [...completions].reverse().forEach((request, i) =>
      request.finish({
        ...output,
        images: [{ dataUrl: images[i], mediaType: "image/png" }],
      }),
    );
  });
  await waitFor(() => expect(historyItems[0].status).toBe("ok"));
  expect(historyItems[0].resultFiles).toHaveLength(4);
  expect(
    historyItems[0].batch?.requests.every((request) => request.status === "ok"),
  ).toBe(true);
  expect(historyItems[0].cost).toBe(output.usage!.cost! * 4);
  expect(ui.getAllByAltText(/候选图片/)).toHaveLength(4);
});

test("gallery import only adds owned assets; picker reuses assets in selection order and undo restores references", async () => {
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "图库" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: "图库" }));
  fireEvent.click(ui.getByRole("button", { name: "导入图片" }));
  await waitFor(() => expect(galleryItems).toHaveLength(2));
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "查看图片 second.png" }),
    ).toBeTruthy(),
  );
  fireEvent.click(ui.getByRole("button", { name: "生成" }));
  expect(ui.getByRole("heading", { name: /素材\s*0\/10/ })).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "从图库选择" }));
  const dialog = ui.getByRole("dialog", { name: "从图库选择" });
  const { within } = await import("@testing-library/react");
  const picker = within(dialog);
  fireEvent.click(picker.getByRole("button", { name: "选择图片 second.png" }));
  fireEvent.click(picker.getByRole("button", { name: "选择图片 first.png" }));
  await act(async () => {
    fireEvent.click(
      picker.getByRole("button", { name: "添加为参考素材 · 2 张" }),
    );
  });
  await waitFor(() => expect(ui.queryByRole("dialog")).toBeNull());
  expect(galleryItems).toHaveLength(2);
  expect(
    ui
      .getAllByRole("img")
      .filter((im) =>
        ["first.png", "second.png"].includes(im.getAttribute("alt") ?? ""),
      )
      .map((im) => im.getAttribute("alt")),
  ).toEqual(["second.png", "first.png"]);
  fireEvent.click(ui.getByTitle("撤销 Ctrl+Z"));
  expect(ui.getByRole("heading", { name: /素材\s*0\/10/ })).toBeTruthy();
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

test("source suggestions cannot execute provider HTML or open non-web URLs", () => {
  const html = searchDocument(
    `<style>.chip{color:blue}</style><script>parent.secret()</script><base href="file:///C:/"><meta http-equiv="refresh" content="0;url=https://bad.example"><form></form><a href="javascript:bad()" onclick="bad()">bad</a><a href="https://www.google.com/search?q=flowers" target="_top" ping="https://tracker.example" onmouseover="bad()">flowers</a>`,
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onclick");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("_top");
  expect(html).not.toContain("<base");
  expect(html).not.toContain("refresh");
  expect(html).not.toContain("tracker.example");
  expect(html).toContain("<style>.chip{color:blue}</style>");
  expect(html).toContain("https://www.google.com/search?q=flowers");
  expect(webUrl("file:///C:/secret.txt")).toBeNull();
  expect(webUrl("https://user:password@example.org")).toBeNull();
  const ui = render(
    <GenerationInfo
      details={{
        text: "",
        thoughts: "",
        sources: [],
        searchQueries: [],
        searchHtml: html,
      }}
    />,
  );
  const frame = ui.getByTitle("Google 搜索建议");
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
});

