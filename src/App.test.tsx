import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type {
  Draft,
  ProviderId,
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
import Gallery from "./components/Gallery";
import GenerationInfo, { searchDocument } from "./components/GenerationInfo";
import { webUrl } from "./lib/links";
import { StrictMode, useState } from "react";
import { WorkspaceSidebar } from "./workspaces";
import { catalog, fieldsFor, defaultsFor } from "./models/catalog";
import { queuedGeneration } from "./app/generation";

const dom = new Window({ url: "http://localhost:5173" });
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
let savedItem: HistoryItem | null = null;
let finish: (out: GenerateOutput) => void = () => {};
let failGeneration: (error: Error) => void = () => {};
let failHistory = false;
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
let destroyed = false;
let blockedImage: string | null = null;
let releaseImageSize: () => void = () => {};
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
  imageSize: async (data: string) => {
    if (data === blockedImage)
      await new Promise<void>((resolve) => {
        releaseImageSize = resolve;
      });
    return { width: 768, height: 768 };
  },
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
const { render, fireEvent, waitFor, cleanup, act } = await import(
  "@testing-library/react"
);
const { default: App } = await import("./App");
beforeEach(() => {
  initial = null;
  submitted = null;
  submissions = [];
  savedItem = null;
  failHistory = false;
  historyItems = [];
  galleryItems = [];
  deletedIds = [];
  failedDeletes = new Set();
  draftWrites = [];
  exportPath = "";
  reportProgress = () => {};
  destroyed = false;
  blockedImage = null;
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
      (ui.getByRole("combobox", { name: "模型系列" }) as HTMLSelectElement)
        .value,
    ).toBe("gpt"),
  );
  expect(ui.getByRole("img", { name: "主图与黑色编辑蒙版" }).tagName).toBe(
    "CANVAS",
  );
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("masked edit");
  expect(
    ui.getByRole("button", { name: "移除蒙版" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("new image families expose official routes, color icons and independent route settings with shared task content", async () => {
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("combobox", { name: "模型系列" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.change(ui.getByRole("combobox", { name: "模型系列" }), {
    target: { value: "gemini" },
  });
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
  fireEvent.change(ui.getByRole("combobox", { name: "模型系列" }), {
    target: { value: "seedream" },
  });
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
  fireEvent.change(restarted.getByRole("combobox", { name: "模型系列" }), {
    target: { value: "gemini" },
  });
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
  fireEvent.click(await ui.findByRole("button", { name: "另存为" }));
  await waitFor(() => expect(exportPath).toEndWith("-2.webp"));
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

test("ordinary generation has no canvas; composition is explicit, undoable, and repeat count survives navigation", async () => {
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(ui.container.querySelector(".canvas-surface")).toBeNull();
  fireEvent.click(ui.getByRole("checkbox", { name: "区域构图" }));
  expect(ui.container.querySelector(".canvas-surface")).not.toBeNull();
  fireEvent.click(ui.getByTitle("撤销 Ctrl+Z"));
  expect(ui.container.querySelector(".canvas-surface")).toBeNull();
  fireEvent.change(ui.getByRole("spinbutton", { name: "生成张数" }), {
    target: { value: "8" },
  });
  fireEvent.click(ui.getByRole("button", { name: "历史" }));
  fireEvent.click(ui.getByRole("button", { name: "方案" }));
  expect(
    (ui.getByRole("spinbutton", { name: "生成张数" }) as HTMLInputElement)
      .value,
  ).toBe("8");
  fireEvent.click(ui.getByRole("button", { name: "编辑" }));
  expect(
    (ui.getByRole("spinbutton", { name: "生成张数" }) as HTMLInputElement)
      .value,
  ).toBe("1");
  fireEvent.click(ui.getByRole("button", { name: "生成" }));
  expect(
    (ui.getByRole("spinbutton", { name: "生成张数" }) as HTMLInputElement)
      .value,
  ).toBe("8");
});

test("decoding a selected candidate cannot discard later batch outputs or reset the selection", async () => {
  initial = { ...newDraft(), prompt: "three candidates", repeatCount: 3 };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: /^生成图像/ }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: /^生成图像/ }));
  await waitFor(() => expect(submissions).toHaveLength(1));
  await act(async () => finish(output));
  await waitFor(() => expect(submissions).toHaveLength(2));
  const second = "data:image/png;base64,c2Vjb25k";
  await act(async () =>
    finish({
      ...output,
      images: [{ dataUrl: second, mediaType: "image/png" }],
    }),
  );
  await waitFor(() => expect(submissions).toHaveLength(3));
  blockedImage = second;
  fireEvent.click(ui.getByRole("button", { name: "查看结果 2" }));
  await act(async () => finish(output));
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "查看结果 3" })).toBeTruthy(),
  );
  await act(async () => {
    blockedImage = null;
    releaseImageSize();
  });
  await waitFor(() =>
    expect(ui.getByAltText("生成结果").getAttribute("src")).toBe(second),
  );
  expect(
    ui.getByRole("button", { name: "查看结果 2" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(ui.getByRole("button", { name: "查看结果 3" })).toBeTruthy();
  expect(historyItems[0].resultFiles).toHaveLength(3);
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
    expect(ui.getByText("已存图库", { exact: false })).toBeTruthy(),
  );
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("next version while running");
  expect(ui.getByRole("heading", { name: /素材\s*2\/10/ })).toBeTruthy();
  expect(savedItem!.prompt).toBe("original prompt");
  expect(savedItem!.recipe!.refIds).toEqual(["a"]);
  expect(submitted!.params.version).toBe("latest");
  expect(ui.getByRole("button", { name: "另存为" })).toBeTruthy();
  fireEvent.click(await ui.findByRole("button", { name: "另存为" }));
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
  fireEvent.change(ui.getByRole("combobox", { name: "模型系列" }), {
    target: { value: "gpt" },
  });
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

for (const keep of [false, true])
  test(`replacing existing editing work can cancel, choose references (${keep}), and undo`, async () => {
    const main = {
      uid: "old-main",
      name: "old main",
      dataUrl: "data:image/png;base64,b2xk",
      width: 1024,
      height: 1024,
    };
    const old: Draft = {
      ...newDraft(undefined, "gpt"),
      provider: "comfy",
      intent: "edit",
      baseId: main.uid,
      prompt: "unfinished instruction",
      refs: [
        main,
        {
          ...main,
          uid: "style-ref",
          name: "style ref",
          dataUrl: "data:image/png;base64,c3R5bGU=",
          purpose: "style",
        },
      ],
      mask: { ...main, name: "old mask" },
    };
    initial = {
      schema: 2,
      activeIntent: "create",
      tasks: { create: { ...newDraft(), prompt: "new candidate" }, edit: old },
    };
    const ui = render(<App />);
    await waitFor(() =>
      expect(
        ui
          .getByRole("button", { name: /^生成图像 ·/ })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(ui.getByRole("button", { name: /^生成图像 ·/ }));
    await waitFor(() => expect(submitted).not.toBeNull());
    await act(async () => finish(output));
    fireEvent.click(
      await ui.findByRole("button", { name: "用这张图开始编辑" }),
    );
    expect(ui.getByRole("dialog", { name: "开始新的图片编辑" })).toBeTruthy();
    expect(ui.getByAltText("当前编辑主图").getAttribute("src")).toBe(
      main.dataUrl,
    );
    expect(
      (
        ui.getByRole("checkbox", {
          name: /沿用其他参考素材/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await act(async () =>
      fireEvent.click(ui.getByRole("button", { name: "取消" })),
    );
    expect(ui.queryByRole("dialog")).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "编辑" }));
    expect(
      (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement)
        .value,
    ).toBe(old.prompt);
    expect(ui.getByRole("img", { name: "主图与黑色编辑蒙版" })).toBeTruthy();
    fireEvent.click(ui.getByRole("button", { name: "生成" }));
    fireEvent.click(ui.getByRole("button", { name: "用这张图开始编辑" }));
    if (keep)
      fireEvent.click(ui.getByRole("checkbox", { name: /沿用其他参考素材/ }));
    await act(async () =>
      fireEvent.click(ui.getByRole("button", { name: "替换并开始编辑" })),
    );
    expect(
      (ui.getByRole("combobox", { name: "提供商" }) as HTMLSelectElement).value,
    ).toBe("comfy");
    expect(
      (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement)
        .value,
    ).toBe("");
    expect(ui.queryByRole("button", { name: "移除蒙版" })).toBeNull();
    expect(!!ui.queryByRole("combobox", { name: "素材用途 style ref" })).toBe(
      keep,
    );
    fireEvent.click(ui.getByRole("button", { name: "撤销 Ctrl+Z" }));
    expect(
      (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement)
        .value,
    ).toBe(old.prompt);
    expect(ui.getByRole("img", { name: "主图与黑色编辑蒙版" })).toBeTruthy();
    expect(
      ui.getByRole("combobox", { name: "素材用途 style ref" }),
    ).toBeTruthy();
  });

test("cross-model editing keeps the main image, prompt and mask, and model changes undo", async () => {
  const image = {
    uid: "main",
    name: "main",
    dataUrl: "data:image/png;base64,YQ==",
    width: 1024,
    height: 1024,
  };
  initial = {
    ...newDraft(undefined, "gpt"),
    provider: "comfy",
    intent: "edit",
    baseId: "main",
    refs: [image],
    mask: { ...image, name: "mask" },
    prompt: "make it snow",
  };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement)
        .value,
    ).toBe("make it snow"),
  );
  fireEvent.change(ui.getByRole("combobox", { name: "模型系列" }), {
    target: { value: "gemini" },
  });
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("make it snow");
  expect(ui.getByText("main")).toBeTruthy();
  expect(
    ui.getByRole("button", { name: /^应用编辑 ·/ }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(ui.getByRole("button", { name: "移除蒙版" }));
  expect(
    ui.getByRole("button", { name: /^应用编辑 ·/ }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(ui.getByRole("button", { name: "撤销 Ctrl+Z" }));
  expect(ui.getByRole("button", { name: "移除蒙版" })).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "撤销 Ctrl+Z" }));
  expect(
    (ui.getByRole("combobox", { name: "模型系列" }) as HTMLSelectElement).value,
  ).toBe("gpt");
  expect(ui.getByRole("img", { name: "主图与黑色编辑蒙版" })).toBeTruthy();
  expect(
    (ui.getByRole("combobox", { name: "提供商" }) as HTMLSelectElement).value,
  ).toBe("comfy");
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
  await act(async () =>
    fireEvent.click(ui.getByRole("button", { name: "替换并开始编辑" })),
  );

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
  await waitFor(() => expect(ui.getAllByAltText("候选图片 1")).toHaveLength(2));
  fireEvent.click(ui.getByRole("button", { name: /查看批次/ }));
  await waitFor(() =>
    expect(ui.getByRole("dialog", { name: "生成结果" })).toBeTruthy(),
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

test("stopping an eight-image batch preserves current outputs and releases a cross-model edit", async () => {
  initial = {
    ...newDraft(undefined, "gpt"),
    prompt: "candidate batch",
    repeatCount: 8,
  };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: /^生成图像 ·/ }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: /^生成图像 ·/ }));
  await waitFor(() => expect(submissions).toHaveLength(1));
  await act(async () => finish(output));
  await waitFor(() => expect(submissions).toHaveLength(2));
  fireEvent.click(ui.getByRole("button", { name: "用这张图开始编辑" }));
  fireEvent.change(ui.getByRole("combobox", { name: "模型系列" }), {
    target: { value: "gemini" },
  });
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "change the sky" },
  });
  fireEvent.click(ui.getByRole("button", { name: /^应用编辑 ·/ }));
  await waitFor(() =>
    expect(
      historyItems.find((i) => i.prompt === "change the sky")?.status,
    ).toBe("queued"),
  );
  fireEvent.click(ui.getByRole("button", { name: "停止后续生成" }));
  expect(ui.queryByRole("button", { name: "停止后续生成" })).toBeNull();
  expect(submissions).toHaveLength(2);
  await act(async () => finish(output));
  await waitFor(() => expect(submissions).toHaveLength(3));
  expect(submissions[2].model).toBe("gemini-3.1-flash-image");
  expect(submissions[2].images).toHaveLength(1);
  expect(submissions[2].finalPrompt).toContain("change the sky");
  const batch = historyItems.find((i) => i.prompt === "candidate batch")!;
  expect(batch.status).toBe("partial");
  expect(batch.batch?.stopped).toBe(true);
  expect(batch.batch?.requests.map((r) => r.status)).toEqual([
    "ok",
    "ok",
    ...Array(6).fill("skipped"),
  ]);
  expect(batch.resultFiles).toHaveLength(2);
  await act(async () => finish({ ...output, model: "gemini-3.1-flash-image" }));
  await waitFor(() =>
    expect(
      historyItems.find((i) => i.prompt === "change the sky")?.status,
    ).toBe("ok"),
  );
  fireEvent.click(ui.getByRole("button", { name: "生成" }));
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("candidate batch");
  expect(ui.getAllByAltText(/候选图片/)).toHaveLength(2);
  expect(submissions).toHaveLength(3);
});
test("stopping subsequent requests does not hide failure of the active request", async () => {
  initial = { ...newDraft(), prompt: "failed active request", repeatCount: 3 };
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: /^生成图像 ·/ }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: /^生成图像 ·/ }));
  await waitFor(() => expect(submissions).toHaveLength(1));
  fireEvent.click(ui.getByRole("button", { name: "停止后续生成" }));
  await act(async () => failGeneration(new Error("provider refused")));
  await waitFor(() => expect(historyItems[0].status).toBe("failed"));
  expect(historyItems[0].batch?.requests.map((r) => r.status)).toEqual([
    "failed",
    "skipped",
    "skipped",
  ]);
  expect(historyItems[0].error).toContain("provider refused");
  expect(submissions).toHaveLength(1);
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
  fireEvent.click(ui.getAllByText("a garden")[0]);
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
  expect(ui.getByRole("button", { name: "用这张图开始编辑" })).toBeTruthy();
  expect(historyItems.find((it) => it.id === batchId)?.status).toBe("running");
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

const galleryFixture = (id: string): GalleryItem => ({
  id,
  name: id,
  createdAt: 1,
  width: 768,
  height: 512,
  mime: "image/png",
  source: "file",
  filePath: `owned/${id}.png`,
  thumbPath: `owned/${id}-thumb.png`,
  historyId: null,
  model: null,
  provider: null,
  pendingDelete: false,
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

test("gallery picker accepts image paste shortcuts without mutating references until confirmed", async () => {
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "从图库选择" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: "从图库选择" }));
  const dialog = ui.getByRole("dialog", { name: "从图库选择" });
  const { within } = await import("@testing-library/react");
  const picker = within(dialog);
  fireEvent.keyDown(picker.getByRole("searchbox", { name: "搜索图库" }), {
    key: "v",
    ctrlKey: true,
  });
  expect(galleryItems).toHaveLength(0);
  fireEvent.keyDown(dialog, { key: "v", ctrlKey: true });
  await waitFor(() => expect(galleryItems).toHaveLength(1));
  await waitFor(() =>
    expect(picker.getByRole("button", { name: "选择图片 clip" })).toBeTruthy(),
  );
  expect(ui.getByRole("heading", { name: /素材\s*0\/10/ })).toBeTruthy();
  fireEvent.click(picker.getByRole("button", { name: "选择图片 clip" }));
  await act(async () => {
    fireEvent.click(
      picker.getByRole("button", { name: "添加为参考素材 · 1 张" }),
    );
  });
  await waitFor(() => expect(ui.queryByRole("dialog")).toBeNull());
  expect(ui.getByRole("heading", { name: /素材\s*1\/10/ })).toBeTruthy();
});

test("gallery picker enforces remaining slots and already-used assets without changing selection order", async () => {
  galleryItems = ["used", "a", "b", "c"].map(galleryFixture);
  let chosen: string[] = [];
  const ui = render(
    <Gallery
      items={galleryItems}
      error=""
      importing={false}
      saveDirectory=""
      onRefresh={async () => {}}
      onFiles={() => {}}
      onPaste={() => {}}
      onUse={async (ids) => {
        chosen = ids;
      }}
      onEdit={async () => {}}
      picker={{ limit: 2, usedIds: ["used"] }}
    />,
  );
  expect(
    ui.getByRole("button", { name: "选择图片 used" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(ui.getByRole("button", { name: "选择图片 b" }));
  fireEvent.click(ui.getByRole("button", { name: "选择图片 a" }));
  expect(
    ui.getByRole("button", { name: "选择图片 c" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(ui.getByRole("button", { name: "添加为参考素材 · 2 张" }));
  await waitFor(() => expect(chosen).toEqual(["b", "a"]));
});

test("gallery deletion confirms, retains failed items for retry, and never calls deletion on cancel", async () => {
  galleryItems = ["a", "b"].map(galleryFixture);
  const props = {
    error: "",
    importing: false,
    saveDirectory: "",
    onRefresh: async () => {
      ui.rerender(<Gallery {...props} items={galleryItems} />);
    },
    onFiles: () => {},
    onPaste: () => {},
    onUse: async () => {},
    onEdit: async () => {},
  };
  const ui = render(<Gallery {...props} items={galleryItems} />);
  fireEvent.click(ui.getByRole("button", { name: "选择" }));
  fireEvent.click(ui.getByRole("button", { name: "选择图片 a" }));
  fireEvent.click(ui.getByRole("button", { name: "选择图片 b" }));
  fireEvent.click(ui.getByRole("button", { name: "删除" }));
  fireEvent.click(ui.getByRole("button", { name: "取消" }));
  expect(deletedIds).toEqual([]);
  failedDeletes.add("b");
  fireEvent.click(ui.getByRole("button", { name: "删除" }));
  fireEvent.click(ui.getByRole("button", { name: "确认删除图片" }));
  await waitFor(() => expect(deletedIds).toEqual(["a"]));
  await waitFor(() =>
    expect(ui.getAllByRole("alert")[0].textContent).toContain("file locked"),
  );
  expect(galleryItems.map((i) => i.id)).toEqual(["b"]);
  failedDeletes.clear();
  await act(async () => {
    fireEvent.click(ui.getByRole("button", { name: "确认删除图片" }));
  });
  await waitFor(() => expect(ui.queryByRole("dialog")).toBeNull());
  expect(galleryItems).toHaveLength(0);
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
  const interrupted = {
    ...structuredClone(job.item),
    id: "interrupted-job",
    status: "interrupted",
  };
  historyItems.push(interrupted);
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
  const restoredBatch = () => historyItems.find((it) => it.id === job.item.id)!;
  await waitFor(() => expect(restoredBatch().status).toBe("ok"));
  expect(historyItems).toHaveLength(2);
  expect(restoredBatch().resultFiles).toHaveLength(2);
  expect(
    restoredBatch().batch?.requests.map((request) => request.status),
  ).toEqual(["ok", "ok"]);
  expect(submissions).toHaveLength(2);
  expect(
    submissions.every((request) => request.historyId === job.item.id),
  ).toBe(true);
  expect(historyItems.find((it) => it.id === interrupted.id)).toEqual(
    interrupted,
  );
});
test("prompt limits follow the compiled route without truncating creative input", async () => {
  const longPrompt = "🌿".repeat(3001);
  initial = {
    ...newDraft(undefined, "seedream"),
    modelId: "seedream-5-pro",
    prompt: longPrompt,
  };
  let ui!: ReturnType<typeof render>;
  await act(async () => {
    ui = render(<App />);
  });
  fireEvent.change(ui.getByRole("combobox", { name: "提供商" }), {
    target: { value: "runware" },
  });
  const prompt = ui.getByRole("textbox", {
    name: "提示词",
  }) as HTMLTextAreaElement;
  expect(prompt.value).toBe(longPrompt);
  expect(prompt.getAttribute("maxlength")).toBeNull();
  expect(prompt.getAttribute("aria-invalid")).toBe("true");
  expect(ui.container.querySelector(".prompt-limit")?.textContent).toContain(
    "3,001 / 3,000",
  );
  expect(
    ui.getByRole("button", { name: /^生成图像 ·/ }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(prompt, { target: { value: "🌿".repeat(3000) } });
  expect(prompt.getAttribute("aria-invalid")).toBe("false");
  expect(
    ui.getByRole("button", { name: /^生成图像 ·/ }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.change(ui.getByRole("combobox", { name: "提供商" }), {
    target: { value: "openrouter" },
  });
  expect(prompt.value).toBe("🌿".repeat(3000));
  expect(ui.container.querySelector(".prompt-limit")?.textContent).toContain(
    "3,000 / 32,000",
  );
});
test("Google creative controls follow route capabilities and retain per-route values", async () => {
  initial = {
    ...newDraft(undefined, "gemini"),
    modelId: "gemini-nano-banana-2.1",
    provider: "google",
    prompt: "a paper flower",
    repeatCount: 2,
  };
  let ui!: ReturnType<typeof render>;
  await act(async () => {
    ui = render(<App />);
  });
  fireEvent.change(ui.getByRole("combobox", { name: "思考级别" }), {
    target: { value: "medium" },
  });
  fireEvent.change(ui.getByRole("combobox", { name: "联网搜索" }), {
    target: { value: "web_images" },
  });
  fireEvent.click(ui.getByRole("checkbox", { name: "返回思考摘要" }));
  fireEvent.click(ui.getByRole("checkbox", { name: "返回文字说明" }));
  fireEvent.change(ui.getByRole("combobox", { name: "模型版本" }), {
    target: { value: "gemini-3-pro-image" },
  });
  expect(ui.queryByRole("combobox", { name: "思考级别" })).toBeNull();
  expect(
    Array.from(
      ui.getByRole("combobox", { name: "联网搜索" }).querySelectorAll("option"),
    ).map((o) => o.value),
  ).toEqual(["none", "web"]);
  fireEvent.change(ui.getByRole("combobox", { name: "模型版本" }), {
    target: { value: "gemini-nano-banana-2.1" },
  });
  expect(
    (ui.getByRole("combobox", { name: "联网搜索" }) as HTMLSelectElement).value,
  ).toBe("web_images");
  fireEvent.click(ui.getByRole("button", { name: /^生成图像 ·/ }));
  await waitFor(() => expect(submitted).not.toBeNull());
  expect(submitted!.params).toMatchObject({
    thinkingLevel: "medium",
    includeThoughts: true,
    searchMode: "web_images",
    responseText: true,
  });
  const info = {
    text: "a paper flower",
    thoughts: "composition summary",
    sources: [
      {
        title: "Flower source",
        url: "https://example.org/flower",
        kind: "image" as const,
      },
    ],
    searchQueries: ["flower"],
    searchHtml: null,
  };
  await act(async () =>
    finish({
      ...output,
      provider: "google",
      model: "gemini-nano-banana-2.1",
      images: output.images.map((im) => ({ ...im, details: info })),
    }),
  );
  await waitFor(() =>
    expect(
      historyItems.find((item) => item.status === "running")?.resultDetails
        ?.result_0,
    ).toEqual(info),
  );
  expect(
    ui.getByRole("link", { name: "Flower source" }).getAttribute("href"),
  ).toBe("https://example.org/flower");
  await waitFor(() => expect(submissions).toHaveLength(2));
  const secondInfo = {
    ...info,
    text: "another flower",
    sources: [
      {
        ...info.sources[0],
        title: "Second source",
        url: "https://example.org/second",
      },
    ],
  };
  await act(async () =>
    finish({
      ...output,
      provider: "google",
      model: "gemini-nano-banana-2.1",
      images: output.images.map((im) => ({ ...im, details: secondInfo })),
    }),
  );
  await waitFor(() =>
    expect(savedItem?.resultDetails).toEqual({
      result_0: info,
      result_1: secondInfo,
    }),
  );
  fireEvent.click(ui.getByRole("button", { name: "查看结果 2" }));
  await waitFor(() =>
    expect(ui.queryByRole("link", { name: "Second source" })).not.toBeNull(),
  );
  expect(ui.queryByRole("link", { name: "Flower source" })).toBeNull();
  fireEvent.change(ui.getByRole("combobox", { name: "提供商" }), {
    target: { value: "openrouter" },
  });
  expect(ui.queryByRole("combobox", { name: "联网搜索" })).toBeNull();
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
test("every declared route parameter has a reachable creative control", () => {
  for (const model of catalog.models)
    for (const provider of Object.keys(model.routes) as ProviderId[]) {
      const initialDraft = {
        ...newDraft(undefined, model.family),
        modelId: model.id,
        provider,
        params: defaultsFor(model.id, provider),
      };
      const fields = fieldsFor(initialDraft);
      function Harness() {
        const [draft, onChange] = useState(initialDraft);
        return (
          <WorkspaceSidebar
            draft={draft}
            onChange={onChange}
            onReorder={() => {}}
            selectedId={null}
            onSelect={() => {}}
            onRename={() => {}}
            providerStatus={null}
            busy={false}
            finalPreview=""
            errors={[]}
            onGenerate={() => {}}
            onSettings={() => {}}
          />
        );
      }
      const ui = render(<Harness />);
      const seen = new Set<string>();
      const collect = () =>
        ui
          .queryAllByRole("group")
          .forEach((el) => seen.add(el.getAttribute("aria-label") ?? ""));
      collect();
      const mode = ui.queryByRole("combobox", { name: "尺寸模式" });
      if (mode) {
        fireEvent.change(mode, { target: { value: "auto" } });
        collect();
        fireEvent.change(mode, { target: { value: "custom" } });
        collect();
      }
      const output = ui.queryByRole("combobox", { name: "输出格式" });
      if (output && fields.outputFormat?.values?.includes("jpeg")) {
        fireEvent.change(output, { target: { value: "jpeg" } });
        collect();
      }
      const extend = ui.queryByRole("checkbox", {
        name: fields.promptExtend?.label ?? "unused",
      }) as HTMLInputElement | null;
      if (extend && !extend.checked) {
        fireEvent.click(extend);
        collect();
      }
      for (const [key, field] of Object.entries(fields)) {
        if (key === "count")
          expect(ui.getByRole("spinbutton", { name: "生成张数" })).toBeTruthy();
        else
          expect({
            model: model.id,
            provider,
            key,
            visible: seen.has(field.label),
          }).toEqual({ model: model.id, provider, key, visible: true });
      }
      ui.unmount();
    }
});
