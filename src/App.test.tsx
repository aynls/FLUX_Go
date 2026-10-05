import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Draft, GenerateOutput, GenerateRequestPayload, HistoryItem } from "./lib/types";
import { newDraft } from "./lib/workspace";

const dom = new Window({ url: "http://localhost:5173" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, HTMLSelectElement: dom.HTMLSelectElement,
  ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
let initial: Draft | null = null;
let submitted: GenerateRequestPayload | null = null;
let savedItem: HistoryItem | null = null;
let finish: (out: GenerateOutput) => void = () => {};
let failHistory = false;
let historyItems: HistoryItem[] = [];
let draftWrites: Draft[] = [];
let exportPath = "";
const output: GenerateOutput = { provider: "bfl", model: "flux-3-image", finalPrompt: "original request", images: [{ dataUrl: "data:image/png;base64,cmVzdWx0", mediaType: "image/png" }], usage: { cost: .0205 }, notes: ["provider note"] };
mock.module("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
mock.module("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
mock.module("@tauri-apps/plugin-dialog", () => ({ open: async (options: { directory?: boolean }) => options.directory ? "D:\\Pictures\\Flux" : ["first.png", "second.png"], save: async (options: { defaultPath: string }) => { exportPath = options.defaultPath; return null; } }));
mock.module("./lib/image", () => ({ imageSize: async () => ({ width: 768, height: 768 }), makeThumb: async () => "thumb", downscaleDataUrl: async (s: string) => s }));
mock.module("./lib/api", () => ({
  AppError: class extends Error {}, providerStatus: async () => ({ bfl: true, openrouter: true }), draftLoad: async () => initial, draftSave: async (d: Draft) => { draftWrites.push(d); },
  historyList: async () => historyItems, generate: (request: GenerateRequestPayload) => { submitted = request; return new Promise<GenerateOutput>(resolve => { finish = resolve; }); },
  historySave: async (item: HistoryItem) => { if (failHistory) throw new Error("disk full"); savedItem = item; return item; },
  importImage: async (path: string) => ({ dataUrl: "data:image/png;base64," + path, name: path, width: path.includes("first") ? 1200 : 600, height: 800 }),
  clipboardImage: async () => ({ dataUrl: "data:image/png;base64,YQ==", name: "clip", width: 512, height: 512 }),
  copyImage: async () => {}, historyStorage: async () => "test-only", assetUrl: (s: string) => s, historyDelete: async () => {}, saveDataUrl: async () => {}, importUrl: async () => {},
  credentialSave: async () => {}, credentialRemove: async () => {}, credentialCheck: async () => "verified",
  credentialConfigure: async () => {},
}));
const { render, fireEvent, waitFor, cleanup, act } = await import("@testing-library/react");
const { default: App } = await import("./App");
beforeEach(() => { initial = null; submitted = null; savedItem = null; failHistory = false; historyItems = []; draftWrites = []; exportPath = ""; dom.localStorage.clear(); });
afterEach(cleanup);

test("chosen export directory persists across app restart", async () => {
  const ui = render(<App />);
  await waitFor(() => expect(ui.getByRole("button", { name: "新建方案" }).hasAttribute("disabled")).toBe(false));
  await act(async () => { fireEvent.click(ui.getAllByRole("button", { name: "设置" })[0]); });
  await act(async () => { fireEvent.click(ui.getByRole("button", { name: "选择文件夹" })); });
  await waitFor(() => expect(JSON.parse(dom.localStorage.getItem("flux-preferences-v2")!).saveDirectory).toBe("D:\\Pictures\\Flux"));
  ui.unmount();
  const restarted = render(<App />);
  await waitFor(() => expect(restarted.getByRole("button", { name: "新建方案" }).hasAttribute("disabled")).toBe(false));
  await act(async () => { fireEvent.click(restarted.getAllByRole("button", { name: "设置" })[0]); });
  expect(restarted.getByText("D:\\Pictures\\Flux")).toBeTruthy();
});

test("invalid saved draft is preserved until explicit new scheme", async () => {
  initial = { ...newDraft(), schema: 999 } as unknown as Draft;
  const ui = render(<App />);
  await waitFor(() => expect(ui.getByText(/已暂停保存以保留原文件/)).toBeTruthy());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  expect(draftWrites).toHaveLength(0);
  fireEvent.click(ui.getByRole("button", { name: "新建方案" }));
  await waitFor(() => expect(draftWrites.length).toBeGreaterThan(0));
});

test("history restores all references, provider and compression; undo recovers current work", async () => {
  dom.localStorage.setItem("flux-preferences-v2", JSON.stringify({ saveDirectory: "D:\\Pictures\\Flux" }));
  initial = { ...newDraft(), prompt: "current work" };
  const recipe = { ...newDraft(), provider: "bfl" as const, prompt: "saved two reference edit", compressEnabled: false, maxInputEdge: 4096, baseId: "second", refNames: ["base", "detail"], refIds: ["first", "second"] };
  historyItems = [{ id: "saved", createdAt: 1, provider: "bfl", model: "flux-3-image", mode: "edit", prompt: recipe.prompt, finalPrompt: recipe.prompt, params: { ...recipe.params }, boxes: [], canvasWidth: 1024, canvasHeight: 1024, inputFiles: ["first.png", "second.png"], resultFiles: ["result.webp"], thumb: null, usage: {}, cost: null, status: "ok", recipe }];
  const ui = render(<App />);
  await waitFor(() => expect(ui.getByText("已恢复上次方案")).toBeTruthy());
  fireEvent.click(ui.getByRole("button", { name: "历史 · 1" }));
  fireEvent.click(ui.getByText(recipe.prompt));
  fireEvent.click(ui.getByRole("button", { name: /另存为/ }));
  await waitFor(() => expect(exportPath).toBe("D:\\Pictures\\Flux\\flux-saved.webp"));
  fireEvent.click(ui.getByRole("button", { name: "恢复完整方案" }));
  await waitFor(() => expect(ui.getByText("参考素材 · 2/10")).toBeTruthy());
  expect((ui.getByRole("combobox", { name: "提供商" }) as HTMLSelectElement).value).toBe("bfl");
  fireEvent.click(ui.getByText("高级参数与发送检查"));
  expect((ui.getByRole("checkbox", { name: "发送前等比缩小参考图" }) as HTMLInputElement).checked).toBe(false);
  expect((ui.getByRole("spinbutton", { name: "长边上限（px）" }) as HTMLInputElement).value).toBe("4096");
  fireEvent.click(ui.getByRole("button", { name: "撤销 Ctrl+Z" }));
  expect((ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value).toBe("current work");
  expect(ui.getByText("参考素材 · 0/10")).toBeTruthy();
});

test("multi-file import leaves output canvas and existing boxes intact", async () => {
  initial = { ...newDraft(), prompt: "existing layout", boxes: [{ uid: "stable", id: "obj_1", role: "place", rect: { x: 1, y: 1, w: 20, h: 20 }, desc: "tree" }] };
  const ui = render(<App />);
  await waitFor(() => expect(ui.getByText("已恢复上次方案")).toBeTruthy());
  fireEvent.click(ui.getByRole("button", { name: "添加文件" }));
  await waitFor(() => expect(ui.getByText("参考素材 · 2/10")).toBeTruthy());
  expect(ui.getByText("区域 · 1")).toBeTruthy();
  expect(ui.getByText("1. first.png")).toBeTruthy(); expect(ui.getByText("2. second.png")).toBeTruthy();
  expect(ui.getAllByText("1024×1024").length).toBeGreaterThan(0);
});
test("in-flight snapshot is immutable; result does not overwrite newer draft or references", async () => {
  dom.localStorage.setItem("flux-preferences-v2", JSON.stringify({ saveDirectory: "D:\\Pictures\\Flux\\" }));
  initial = { ...newDraft(), provider: "bfl", prompt: "original prompt", refs: [{ uid: "a", dataUrl: "data:image/png;base64,YQ==", width: 512, height: 512, name: "source" }] };
  const ui = render(<App />);
  await waitFor(() => expect(ui.getByText("已恢复上次方案")).toBeTruthy());
  fireEvent.click(ui.getByRole("button", { name: /^生成 ·/ }));
  await waitFor(() => expect(submitted).not.toBeNull());
  fireEvent.change(ui.getByRole("textbox", { name: "提示词" }), { target: { value: "next version while running" } });
  fireEvent.click(ui.getByRole("button", { name: "粘贴图片" }));
  await waitFor(() => expect(ui.getByText("参考素材 · 2/10")).toBeTruthy());
  expect(ui.getByRole("button", { name: "生成任务进行中…" }).hasAttribute("disabled")).toBe(true);
  await act(async () => { finish(output); });
  await waitFor(() => expect(ui.getByText("已存历史", { exact: false })).toBeTruthy());
  expect((ui.getByRole("textbox", { name: "提示词" }) as HTMLTextAreaElement).value).toBe("next version while running");
  expect(ui.getByText("参考素材 · 2/10")).toBeTruthy();
  expect(savedItem!.prompt).toBe("original prompt");
  expect(savedItem!.recipe!.refIds).toEqual(["a"]);
  expect(submitted!.params.version).toBe("latest");
  expect(ui.getByRole("button", { name: "另存为" })).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "另存为" }));
  await waitFor(() => expect(exportPath).toBe("D:\\Pictures\\Flux\\flux-" + savedItem!.id.slice(0, 8) + ".png"));
});
test("history failure keeps result usable and retry saves without another generation", async () => {
  initial = { ...newDraft(), prompt: "test prompt" }; failHistory = true;
  const ui = render(<App />);
  await waitFor(() => expect(ui.getByText("已恢复上次方案")).toBeTruthy());
  fireEvent.click(ui.getByRole("button", { name: /^生成 ·/ }));
  await waitFor(() => expect(submitted).not.toBeNull());
  const request = submitted;
  await act(async () => { finish(output); });
  await waitFor(() => expect(ui.getByRole("button", { name: "重新保存历史" })).toBeTruthy());
  expect(ui.getByRole("button", { name: "复制图片" })).toBeTruthy();
  failHistory = false;
  fireEvent.click(ui.getByRole("button", { name: "重新保存历史" }));
  await waitFor(() => expect(savedItem).not.toBeNull());
  expect(submitted).toBe(request);
});
