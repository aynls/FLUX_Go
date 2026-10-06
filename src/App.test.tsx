import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type {
  Draft,
  WorkspaceSession,
  GenerateOutput,
  GenerateRequestPayload,
  HistoryItem,
} from "./lib/types";
import { newDraft } from "./lib/workspace";

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
let savedItem: HistoryItem | null = null;
let finish: (out: GenerateOutput) => void = () => {};
let failHistory = false;
let historyItems: HistoryItem[] = [];
let draftWrites: (Draft | WorkspaceSession)[] = [];
let exportPath = "";
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
    onCloseRequested: async () => () => {},
    destroy: async () => {},
  }),
}));
mock.module("@tauri-apps/plugin-dialog", () => ({
  open: async (options: { directory?: boolean }) =>
    options.directory ? "D:\\Pictures\\Flux" : ["first.png", "second.png"],
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
  generate: (request: GenerateRequestPayload) => {
    submitted = request;
    return new Promise<GenerateOutput>((resolve) => {
      finish = resolve;
    });
  },
  historySave: async (item: HistoryItem) => {
    if (failHistory) throw new Error("disk full");
    savedItem = item;
    return item;
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
  historyDelete: async () => {},
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
  savedItem = null;
  failHistory = false;
  historyItems = [];
  draftWrites = [];
  exportPath = "";
  dom.localStorage.clear();
});
afterEach(cleanup);

test("history keeps multiple results and restores the GPT mask into its own workspace", async () => {
  const draft = {
    ...newDraft(undefined, "gpt"),
    provider: "comfy" as const,
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
  fireEvent.click(ui.getByRole("button", { name: /^生成 · 约 .*Credits/ }));
  await waitFor(() => expect(submitted).not.toBeNull());
  expect(submitted!.model).toBe("gpt-image-2.5-flare");
  expect(submitted!.params.size).toBe("1024x1024");
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
  fireEvent.click(ui.getByRole("button", { name: "生成 · 1 张" }));
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
  expect(
    ui.getByRole("button", { name: "生成结果" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(ui.getByRole("tab", { name: "GPT Image 2.5" }));
  expect(
    ui.getByRole("button", { name: "生成结果" }).hasAttribute("disabled"),
  ).toBe(false);
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
    fireEvent.click(ui.getByRole("button", { name: "选择文件夹" }));
  });
  await waitFor(() =>
    expect(
      JSON.parse(dom.localStorage.getItem("flux-preferences-v2")!)
        .saveDirectory,
    ).toBe("D:\\Pictures\\Flux"),
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
  expect(restarted.getByText("D:\\Pictures\\Flux")).toBeTruthy();
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
    "flux-preferences-v2",
    JSON.stringify({ saveDirectory: "D:\\Pictures\\Flux" }),
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
    expect(exportPath).toBe("D:\\Pictures\\Flux\\flux-saved.webp"),
  );
  fireEvent.click(ui.getByRole("button", { name: "恢复完整方案" }));
  await waitFor(() => expect(ui.getByText("参考素材 · 2/10")).toBeTruthy());
  expect(
    (ui.getByRole("combobox", { name: "提供商" }) as HTMLSelectElement).value,
  ).toBe("bfl");
  fireEvent.click(ui.getByText("发送检查"));
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
  expect(ui.getByText("参考素材 · 0/10")).toBeTruthy();
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
  await waitFor(() => expect(ui.getByText("参考素材 · 2/10")).toBeTruthy());
  expect(ui.getByText("区域 · 1")).toBeTruthy();
  expect(ui.getByText("1. first.png")).toBeTruthy();
  expect(ui.getByText("2. second.png")).toBeTruthy();
  expect(ui.getAllByText("1024×1024").length).toBeGreaterThan(0);
});
test("in-flight snapshot is immutable; result does not overwrite newer draft or references", async () => {
  dom.localStorage.setItem(
    "flux-preferences-v2",
    JSON.stringify({ saveDirectory: "D:\\Pictures\\Flux\\" }),
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
  fireEvent.click(ui.getByRole("button", { name: /^生成 ·/ }));
  await waitFor(() => expect(submitted).not.toBeNull());
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), {
    target: { value: "next version while running" },
  });
  fireEvent.click(ui.getByRole("button", { name: "粘贴图片" }));
  await waitFor(() => expect(ui.getByText("参考素材 · 2/10")).toBeTruthy());
  expect(
    ui
      .getByRole("button", { name: "生成任务进行中…" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await act(async () => {
    finish(output);
  });
  await waitFor(() =>
    expect(ui.getByText("已存历史", { exact: false })).toBeTruthy(),
  );
  expect(
    (ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value,
  ).toBe("next version while running");
  expect(ui.getByText("参考素材 · 2/10")).toBeTruthy();
  expect(savedItem!.prompt).toBe("original prompt");
  expect(savedItem!.recipe!.refIds).toEqual(["a"]);
  expect(submitted!.params.version).toBe("latest");
  expect(ui.getByRole("button", { name: "另存为" })).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "另存为" }));
  await waitFor(() =>
    expect(exportPath).toBe(
      "D:\\Pictures\\Flux\\flux-" + savedItem!.id.slice(0, 8) + ".png",
    ),
  );
});
test("history failure keeps result usable and retry saves without another generation", async () => {
  initial = { ...newDraft(), prompt: "test prompt" };
  failHistory = true;
  const ui = render(<App />);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "新建" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(ui.getByRole("button", { name: /^生成 ·/ }));
  await waitFor(() => expect(submitted).not.toBeNull());
  const request = submitted;
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
