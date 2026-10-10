// Transport-independent application actions. The MCP bridge calls these with
// a live workspace/task host; the UI shares the same preparation and
// submission path. No React or Tauri imports live here.

import type {
  Draft,
  ProviderId,
  Rect,
  TaskIntent,
  WorkingImage,
} from "../lib/types";
import type { ImportedImage } from "../lib/api";
import {
  catalog,
  defaultsFor,
  fieldsFor,
  modelById,
  providers,
  singleImageDraft,
} from "../models/catalog";
import { compileDraft, buildRequest } from "../models";
import {
  primaryImage,
  sentSize,
  validateDraft,
  workspaceKey,
} from "../lib/workspace";
import { regionsEnabled, requiresLayout } from "../models/flux/layout";
import {
  errorPayload,
  fail,
  inactiveParamKeys,
  parameterSchemaFor,
  prepareWorkspacePatch,
  type WorkspacePatch,
} from "./workspaceActions";

export interface McpSubmissionRecord {
  idempotencyKey: string;
  workspaceVersion: string;
  taskId: string;
}

export interface ActionResult {
  structured: unknown;
  content?: { type: string; data?: string; mimeType?: string; text?: string }[];
}

/** Liveness guard supplied by a transport; UI calls use the no-op default. */
export interface ActionContext {
  assertActive(): void;
}

const NO_CONTEXT: ActionContext = { assertActive: () => {} };

export interface ApplicationHost {
  /** Workspace and generation restoration are complete. */
  ready(): boolean;
  getVersion(): string;
  isGestureActive(): boolean;
  /** Draft persistence and library access are possible right now. */
  canPersist(): boolean;
  /** Storage migration, importing, saving, admission or running tasks. */
  isBusy(): boolean;
  /**
   * Narrower admission gate for submissions: migration, import/save, gesture
   * and accepting. Running tasks do NOT block a new submission.
   */
  submitBlocked(): boolean;
  readCurrent(): Draft;
  readIntent(intent: TaskIntent): Draft;
  /** One undoable commit; the DOM commit finishes before returning. */
  commit(next: Draft): void;
  persist(snapshot: Draft): Promise<void>;
  /** Queues an immutable snapshot; resolves to the task id, or undefined when the host is not accepting. */
  submit(
    snapshot: Draft,
    count: number,
    mcp?: { idempotencyKey: string; workspaceVersion: string },
  ): Promise<string | undefined>;
  stopRemaining(taskId: string): { stopped: boolean };
  mcpSubmissionGet(key: string): Promise<McpSubmissionRecord | null>;
  readAsset(assetId: string): Promise<ImportedImage>;
  maskFromRects(image: WorkingImage, rects: Rect[]): WorkingImage;
  makePreview(dataUrl: string): Promise<string>;
  /** Configured-provider flags; booleans only, null until loaded. */
  providerStatus(): Record<string, boolean> | null;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function modelSummaries() {
  return catalog.models.map((model) => ({
    id: model.id,
    family: model.family,
    label: model.label,
    providers: Object.keys(model.routes),
  }));
}

/** Effective values of only the fields this route actually supports. */
function supportedParams(d: Draft) {
  const defaults = defaultsFor(d.modelId, d.provider);
  return Object.fromEntries(
    Object.keys(fieldsFor(d)).map((key) => [
      key,
      d.params[key] !== undefined ? d.params[key] : (defaults[key] ?? null),
    ]),
  );
}

function routeCapabilities(
  modelId: string,
  provider: string,
  draft?: Draft,
) {
  const model = modelById(modelId);
  const route = model?.routes[provider as ProviderId];
  if (!model || !route)
    fail("ROUTE_UNAVAILABLE", "This model has no route on that provider", {
      modelId,
      provider,
    });
  const fields = fieldsFor({ modelId, provider: provider as ProviderId });
  const merged = {
    ...defaultsFor(modelId, provider as ProviderId),
    ...(draft?.params ?? {}),
  };
  return {
    modelId,
    provider,
    nativeModel: route.model,
    defaults: defaultsFor(modelId, provider as ProviderId),
    fields,
    parameterSchema: parameterSchemaFor(fields),
    limits: {
      maxRefs: route.maxRefs,
      mask: route.mask,
      minPrompt: route.minPrompt ?? null,
      maxPrompt: route.maxPrompt ?? null,
      minPixels: route.minPixels ?? null,
      maxPixels: route.maxPixels ?? null,
      maxAspect: route.maxAspect ?? null,
      maxInputBytes: route.maxInputBytes ?? null,
      maxInputPixels: route.maxInputPixels ?? null,
      maxRequestBytes: route.maxRequestBytes ?? null,
    },
    supportsLayout: model.family === "flux",
    requiresLayout: draft ? requiresLayout(draft) : null,
    conditionalRules: [
      {
        fields: ["outputCompression"],
        when: { outputFormat: "png" },
        omittedFromRequest: true,
      },
      {
        fields: ["promptExtendMode", "enableThinking"],
        when: { promptExtend: false },
        omittedFromRequest: true,
      },
    ],
    seedAssignedOnSubmit: fields.seed !== undefined && merged.seed == null,
  };
}

function refSummary(ref: WorkingImage) {
  return {
    uid: ref.uid,
    assetId: ref.assetId,
    name: ref.name,
    width: ref.width,
    height: ref.height,
    ...(ref.purpose ? { purpose: ref.purpose } : {}),
    ...(ref.note ? { note: ref.note } : {}),
  };
}

function issues(d: Draft): string[] {
  const compiled = compileDraft(d);
  return [...validateDraft(d), ...(compiled.error ? [compiled.error] : [])];
}

function workspaceSummary(host: ApplicationHost, d: Draft) {
  const primary = d.intent === "edit" ? primaryImage(d) : null;
  return {
    version: host.getVersion(),
    intent: d.intent,
    modelId: d.modelId,
    provider: d.provider,
    prompt: d.prompt,
    params: supportedParams(d),
    refs: d.refs.map(refSummary),
    primaryRefUid: primary?.uid ?? null,
    canvas: d.canvas,
    mask: d.mask
      ? {
          ...refSummary(d.mask),
          rects: d.maskRects ?? undefined,
        }
      : null,
    boxes: d.boxes.map((b) => ({
      uid: b.uid,
      id: b.id,
      role: b.role,
      rect: b.rect,
      ...(b.srcRect ? { srcRect: b.srcRect } : {}),
      ...(b.sourceId ? { sourceId: b.sourceId } : {}),
      desc: b.desc,
    })),
    layoutEnabled: d.layoutEnabled ?? null,
    layoutActive: regionsEnabled(d),
    compressEnabled: d.compressEnabled,
    maxInputEdge: d.maxInputEdge,
    repeatCount: d.repeatCount ?? 1,
    capabilities: routeCapabilities(d.modelId, d.provider, d),
    issues: issues(d),
  };
}

function checkVersion(host: ApplicationHost, expected: unknown): string {
  if (typeof expected !== "string" || !expected)
    fail("INVALID_ARGS", "expectedVersion is required");
  if (expected !== host.getVersion())
    fail("VERSION_CONFLICT", "the workspace changed; read workspace_get again", {
      current: host.getVersion(),
    });
  return expected;
}

const requireReady = (host: ApplicationHost) => {
  if (!host.ready()) fail("UI_NOT_READY", "the workspace is still restoring");
  if (host.isGestureActive())
    fail("UI_BUSY", "wait for the active edit to finish");
};

const requireUsable = (host: ApplicationHost) => {
  requireReady(host);
  if (host.isBusy() || !host.canPersist())
    fail("UI_BUSY", "storage is busy; try again shortly");
};

/** Immutable snapshot + full validation, shared by the UI and MCP submit. */
export function prepareGeneration(draft: Draft, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 20)
    fail("INVALID_ARGS", "count must be an integer 1-20");
  const snapshot = singleImageDraft(structuredClone(draft));
  return { snapshot, problems: issues(snapshot) };
}

export function createApplicationActions(getHost: () => ApplicationHost) {
  const host = () => getHost();
  /** Concurrent submissions with the same key share one pending task, guarded by version. */
  const pendingSubmits = new Map<
    string,
    { version: string; promise: Promise<ActionResult> }
  >();

  /**
   * The single admission path for generation: capture an immutable snapshot,
   * validate it, persist the draft, recheck availability, then submit. The
   * caller's live draft may change after the snapshot without effect.
   */
  const submitCore = async (
    count: number,
    ctx: ActionContext,
    expected?: string,
    mcpSubmission?: { idempotencyKey: string; workspaceVersion: string },
  ): Promise<{ taskId: string; workspace: string }> => {
    const h = host();
    requireReady(h);
    if (h.submitBlocked() || !h.canPersist())
      fail("UI_BUSY", "storage is busy; try again shortly");
    const { snapshot, problems } = prepareGeneration(h.readCurrent(), count);
    if (problems.length)
      fail("VALIDATION_FAILED", "the draft cannot be submitted", {
        issues: problems,
      });
    if (h.providerStatus()?.[snapshot.provider] !== true)
      fail(
        "PROVIDER_NOT_CONFIGURED",
        "configure this provider before submitting",
        { provider: snapshot.provider },
      );
    // The submitted intent travels with the immutable snapshot so feedback
    // still targets the right workspace when the user switches afterwards.
    const workspace = workspaceKey(snapshot);
    ctx.assertActive();
    await h.persist(snapshot);
    ctx.assertActive();
    const h2 = host();
    if (expected !== undefined) checkVersion(h2, expected);
    requireReady(h2);
    if (h2.submitBlocked() || !h2.canPersist())
      fail("UI_BUSY", "storage is busy; try again shortly");
    ctx.assertActive();
    const taskId = await h2.submit(snapshot, count, mcpSubmission);
    if (!taskId) fail("UI_NOT_READY", "the task queue is not ready");
    return { taskId, workspace };
  };

  const capabilitiesGet = (args: unknown): ActionResult => {
    const spec = (args ?? {}) as { modelId?: string; provider?: string };
    const d = host().readCurrent();
    const modelId = spec.modelId ?? d.modelId;
    const provider = spec.provider ?? d.provider;
    if (typeof modelId !== "string" || typeof provider !== "string")
      fail("INVALID_ARGS", "modelId and provider must be strings");
    const model = modelById(modelId);
    if (!model) fail("MODEL_UNKNOWN", "Unknown model", { modelId });
    // A route other than the active one is described with its own defaults;
    // only the live route reports current params and layout state.
    const context: Draft =
      modelId === d.modelId && provider === d.provider
        ? d
        : {
            ...d,
            modelId,
            provider: provider as ProviderId,
            family: model.family,
            params: defaultsFor(modelId, provider as ProviderId),
          };
    return {
      structured: {
        models: modelSummaries(),
        providers: Object.fromEntries(
          providers.map((p) => [
            p.id,
            host().providerStatus()?.[p.id] === true,
          ]),
        ),
        route: routeCapabilities(modelId, provider, context),
        requiresLayout:
          model.family === "flux" && provider === "runware"
            ? "text-to-image without references"
            : null,
      },
    };
  };

  const workspaceGet = (): ActionResult => {
    const h = host();
    if (!h.ready()) fail("UI_NOT_READY", "the workspace is still restoring");
    return { structured: workspaceSummary(h, h.readCurrent()) };
  };

  const workspacePatch = async (
    args: unknown,
    ctx: ActionContext,
  ): Promise<ActionResult> => {
    const h = host();
    const spec = args as { expectedVersion?: string; patch?: WorkspacePatch };
    const expected = checkVersion(h, spec?.expectedVersion);
    ctx.assertActive();
    requireUsable(h);
    if (typeof spec?.patch !== "object" || spec.patch === null)
      fail("PATCH_INVALID", "patch must be an object");
    const patch = spec.patch as WorkspacePatch;
    if (patch.intent !== undefined && !["create", "edit"].includes(patch.intent))
      fail("PATCH_INVALID", "intent must be create or edit");
    const target = patch.intent
      ? h.readIntent(patch.intent as TaskIntent)
      : h.readCurrent();
    const next = await prepareWorkspacePatch(
      target,
      patch,
      { readAsset: h.readAsset, maskFromRects: h.maskFromRects },
      () => {
        ctx.assertActive();
        return expected === host().getVersion();
      },
    );
    const removedPromptRefs =
      patch.refs !== undefined && patch.prompt === undefined
        ? target.refs.flatMap((ref, index) => {
            const tag = `<ref_image_${index}>`;
            return target.prompt.includes(tag) &&
              !next.refs.some((r) => r.uid === ref.uid)
              ? [{ ...refSummary(ref), tag }]
              : [];
          })
        : [];
    ctx.assertActive();
    const h2 = host();
    checkVersion(h2, expected);
    requireUsable(h2);
    h2.commit(next);
    const h3 = host();
    return {
      structured: {
        ...workspaceSummary(h3, h3.readCurrent()),
        warnings: removedPromptRefs.length
          ? [
              {
                code: "PROMPT_REFERENCES_REMOVED",
                message:
                  "References used by the prompt were removed. Review the returned prompt and refs, then use workspace_patch with the returned version to update the prompt before submitting. Old image tags may now point to different images.",
                references: removedPromptRefs,
              },
            ]
          : [],
      },
    };
  };

  const workspacePreview = (args: unknown): ActionResult => {
    const h = host();
    const spec = args as { expectedVersion?: string };
    checkVersion(h, spec?.expectedVersion);
    requireReady(h);
    const snapshot = singleImageDraft(structuredClone(h.readCurrent()));
    const problems = issues(snapshot);
    const merged = {
      ...defaultsFor(snapshot.modelId, snapshot.provider),
      ...snapshot.params,
    };
    let compiledRequest: unknown = null;
    let effectiveParams: unknown = null;
    try {
      const request = buildRequest(
        snapshot,
        snapshot.refs.map((r) => `<reference:${r.uid}>`),
        snapshot.mask ? `<mask:${snapshot.mask.uid}>` : undefined,
      );
      const { requestId: _requestId, ...rest } = request;
      effectiveParams = request.params;
      compiledRequest = rest;
    } catch {
      /* issues already explain why the draft cannot compile */
    }
    const inputs = snapshot.refs.map((r, i) => ({
      index: i,
      uid: r.uid,
      assetId: r.assetId,
      name: r.name,
      role: i === 0 && snapshot.intent === "edit" ? "primary" : "reference",
      sourceSize: { w: r.width, h: r.height },
      sentSize: sentSize(r, snapshot.compressEnabled, snapshot.maxInputEdge),
    }));
    return {
      structured: {
        version: h.getVersion(),
        compiledRequest,
        effectiveParams,
        inputs,
        mask: snapshot.mask
          ? {
              uid: snapshot.mask.uid,
              sentSize: sentSize(
                snapshot.mask,
                snapshot.compressEnabled,
                snapshot.maxInputEdge,
              ),
            }
          : null,
        repeatCount: snapshot.repeatCount ?? 1,
        omittedParams: inactiveParamKeys(snapshot, merged),
        issues: problems,
        note: "compiledRequest is the shared internal request shape with image placeholders, not a native provider payload",
      },
    };
  };

  const workspaceReadImage = async (
    args: unknown,
    ctx: ActionContext,
  ): Promise<ActionResult> => {
    const h = host();
    const spec = args as { expectedVersion?: string; uid?: string };
    const expected = checkVersion(h, spec?.expectedVersion);
    if (typeof spec?.uid !== "string" || !spec.uid)
      fail("INVALID_ARGS", "uid is required");
    const d = h.readCurrent();
    const image =
      d.refs.find((r) => r.uid === spec.uid) ??
      (d.mask?.uid === spec.uid ? d.mask : undefined);
    if (!image)
      fail("IMAGE_NOT_FOUND", "no reference or mask with this uid", {
        uid: spec.uid,
      });
    ctx.assertActive();
    const thumb = await h.makePreview(image.dataUrl);
    ctx.assertActive();
    checkVersion(h, expected);
    const [, data = ""] = thumb.split(",");
    const mime = /^data:([^;]+)/.exec(thumb)?.[1] ?? "image/jpeg";
    return {
      structured: {
        uid: image.uid,
        name: image.name,
        width: image.width,
        height: image.height,
        mimeType: mime,
      },
      content: [{ type: "image", data, mimeType: mime }],
    };
  };

  const taskSubmit = async (
    args: unknown,
    ctx: ActionContext,
  ): Promise<ActionResult> => {
    const h = host();
    const spec = args as { expectedVersion?: string; idempotencyKey?: string };
    const key = spec?.idempotencyKey;
    if (typeof key !== "string" || !UUID_RE.test(key))
      fail("INVALID_ARGS", "idempotencyKey must be a UUID");
    const expected = spec?.expectedVersion;
    if (typeof expected !== "string" || !expected)
      fail("INVALID_ARGS", "expectedVersion is required");
    const pending = pendingSubmits.get(key);
    if (pending) {
      if (pending.version !== expected)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "this idempotencyKey was used with a different workspace version",
        );
      return pending.promise;
    }
    const work = (async (): Promise<ActionResult> => {
      // The durable ledger wins over the in-memory version: a retried key
      // returns its original task even after restart or history deletion.
      const recorded = await h.mcpSubmissionGet(key);
      ctx.assertActive();
      if (recorded) {
        if (recorded.workspaceVersion !== expected)
          fail(
            "IDEMPOTENCY_CONFLICT",
            "this idempotencyKey was used with a different workspace version",
          );
        return {
          structured: {
            taskId: recorded.taskId,
            alreadySubmitted: true,
          },
        };
      }
      const h2 = host();
      checkVersion(h2, expected);
      const { taskId } = await submitCore(
        h2.readCurrent().repeatCount ?? 1,
        ctx,
        expected,
        {
          idempotencyKey: key,
          workspaceVersion: expected,
        },
      );
      return { structured: { taskId, alreadySubmitted: false } };
    })().finally(() => pendingSubmits.delete(key));
    pendingSubmits.set(key, { version: expected, promise: work });
    return work;
  };

  const taskStopRemaining = (args: unknown): ActionResult => {
    const spec = args as { taskId?: string };
    if (typeof spec?.taskId !== "string" || !spec.taskId)
      fail("INVALID_ARGS", "taskId is required");
    return {
      structured: {
        taskId: spec.taskId,
        ...host().stopRemaining(spec.taskId),
      },
    };
  };

  /** UI entry point: the generate button submits the live draft count. */
  const submitUi = async (count: number): Promise<ActionResult> => {
    const { taskId, workspace } = await submitCore(count, NO_CONTEXT);
    return { structured: { taskId, workspace, alreadySubmitted: false } };
  };

  const dispatch = async (
    name: string,
    args: unknown,
    context?: ActionContext,
  ): Promise<ActionResult> => {
    const ctx = context ?? NO_CONTEXT;
    try {
      ctx.assertActive();
      switch (name) {
        case "capabilities_get":
          return capabilitiesGet(args);
        case "workspace_get":
          return workspaceGet();
        case "workspace_patch":
          return await workspacePatch(args, ctx);
        case "workspace_preview":
          return workspacePreview(args);
        case "workspace_read_image":
          return await workspaceReadImage(args, ctx);
        case "task_submit":
          return await taskSubmit(args, ctx);
        case "task_stop_remaining":
          return taskStopRemaining(args);
        default:
          fail("UNKNOWN_TOOL", `unknown tool ${name}`);
      }
    } catch (e) {
      throw errorPayload(e);
    }
  };

  return { dispatch, submitUi };
}
