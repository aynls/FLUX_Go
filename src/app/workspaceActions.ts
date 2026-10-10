// Transport-independent workspace transformations shared by the UI and the
// MCP bridge. Every rejection carries a stable code; localized text is only
// produced for non-blocking validation issues.

import type {
  Box,
  BoxRole,
  Draft,
  GenerateParams,
  ProviderId,
  Rect,
  WorkingImage,
} from "../lib/types";
import type { ImportedImage } from "../lib/api";
import {
  defaultsFor,
  fieldsFor,
  modelById,
  providers,
  routeFor,
  changeRoute,
  type FieldDefinition,
} from "../models/catalog";
import { gptSize } from "../models/gpt";
import {
  outputEstimate,
  primaryImage,
  reorderRefs,
  resizeCanvas,
  setPrimaryImage,
  withIds,
} from "../lib/workspace";
import { requiresLayout } from "../models/flux/layout";

export class McpError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.details = details;
  }
}

// A function declaration (not a const arrow) so callers get never-narrowing.
export function fail(code: string, message: string, details?: unknown): never {
  throw new McpError(code, message, details);
}

export const errorPayload = (e: unknown): McpError =>
  e instanceof McpError
    ? e
    : new McpError("INTERNAL_ERROR", e instanceof Error ? e.message : String(e));

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkKeys(
  value: unknown,
  allowed: string[],
  what: string,
): Record<string, unknown> {
  if (!isObject(value)) fail("PATCH_INVALID", `${what} must be an object`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.includes(key))
      fail("PATCH_UNSUPPORTED", `${what} has unsupported field ${key}`, {
        field: key,
      });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Route parameter schema and strict value validation.
// ---------------------------------------------------------------------------

const SIZE_GRAMMAR = "^\\s*\\d+\\s*[xX×*]\\s*\\d+\\s*$";

export function parameterSchemaFor(
  fields: Record<string, FieldDefinition>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (key === "count") {
      properties[key] = {
        const: 1,
        readOnly: true,
        description:
          "Native provider count is fixed at 1; use repeatCount for the total number of images.",
      };
      continue;
    }
    let rule: Record<string, unknown>;
    switch (field.kind) {
      case "enum":
        rule = { type: "string", enum: field.values ?? [] };
        break;
      case "integer":
        rule = {
          type: "integer",
          ...(field.min != null ? { minimum: field.min } : {}),
          ...(field.max != null ? { maximum: field.max } : {}),
        };
        break;
      case "boolean":
        rule = { type: "boolean" };
        break;
      case "text":
        // An empty string means unset, matching the live workspace behavior.
        rule =
          field.minLength != null && field.minLength > 0
            ? {
                anyOf: [
                  { const: "" },
                  {
                    type: "string",
                    minLength: field.minLength,
                    ...(field.maxLength != null
                      ? { maxLength: field.maxLength }
                      : {}),
                  },
                ],
              }
            : {
                type: "string",
                ...(field.maxLength != null
                  ? { maxLength: field.maxLength }
                  : {}),
              };
        break;
      case "size":
        rule = field.allowAuto
          ? {
              anyOf: [{ const: "auto" }, { type: "string", pattern: SIZE_GRAMMAR }],
            }
          : { type: "string", pattern: SIZE_GRAMMAR };
        break;
    }
    if (field.nullable) {
      const variants = "anyOf" in rule ? (rule.anyOf as unknown[]) : [rule];
      properties[key] = { anyOf: [...variants, { type: "null" }] };
    } else {
      properties[key] = rule;
    }
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

/** Fields the shared request compiler omits under the current merged params. */
export function inactiveParamKeys(d: Draft, merged: GenerateParams): string[] {
  const inactive: string[] = [];
  if (merged.outputFormat === "png") inactive.push("outputCompression");
  if (merged.promptExtend === false)
    inactive.push("promptExtendMode", "enableThinking");
  return inactive.filter((key) => fieldsFor(d)[key] !== undefined);
}

function validateParamValue(
  key: string,
  field: FieldDefinition,
  value: unknown,
): void {
  if (value === undefined)
    fail("PARAM_INVALID", `params.${key} cannot be undefined`);
  if (value === null) {
    if (!field.nullable)
      fail("PARAM_INVALID", `params.${key} does not accept null`);
    return;
  }
  if (key === "count") {
    if (value !== 1)
      fail("PARAM_INVALID", "params.count is fixed at 1; use repeatCount");
    return;
  }
  switch (field.kind) {
    case "enum":
      if (typeof value !== "string" || !field.values?.includes(value))
        fail("PARAM_INVALID", `params.${key} is not an allowed value`);
      return;
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        !Number.isFinite(value) ||
        value < (field.min ?? -Infinity) ||
        value > (field.max ?? Infinity)
      )
        fail("PARAM_INVALID", `params.${key} is outside its range`);
      return;
    case "boolean":
      if (typeof value !== "boolean")
        fail("PARAM_INVALID", `params.${key} must be a boolean`);
      return;
    case "text":
      if (
        typeof value !== "string" ||
        value.length > (field.maxLength ?? Infinity) ||
        (value.length > 0 && value.length < (field.minLength ?? 0))
      )
        fail("PARAM_INVALID", `params.${key} is not valid text`);
      return;
    case "size":
      if (
        typeof value !== "string" ||
        !(value === "auto" ? field.allowAuto : gptSize(value) !== null)
      )
        fail("PARAM_INVALID", `params.${key} is not a valid size`);
      return;
  }
}

// ---------------------------------------------------------------------------
// Sizing normalization shared with the live workspace onChange.
// ---------------------------------------------------------------------------

/** The resize rules the canvas applies when dimension fields change. */
export function normalizeDraftChange(previous: Draft, next: Draft): Draft {
  const fields = fieldsFor(next);
  let d = next;
  if (
    fields.aspectRatio &&
    (next.params.aspectRatio !== previous.params.aspectRatio ||
      next.params.resolution !== previous.params.resolution ||
      next.provider !== previous.provider)
  )
    d = resizeCanvas(next, outputEstimate(next));
  if (
    (fields.size && next.params.size !== previous.params.size) ||
    (fields.width &&
      (next.params.width !== previous.params.width ||
        next.params.height !== previous.params.height))
  ) {
    const size = outputEstimate(next);
    if (size.w > 0 && size.h > 0) d = resizeCanvas(next, size);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Workspace patch contract (mirrors shared/mcp-tools.json workspace_patch).
// ---------------------------------------------------------------------------

export type FieldPatchValue = string | number | boolean | null;

export interface WorkspacePatch {
  intent?: "create" | "edit";
  modelId?: string;
  provider?: string;
  prompt?: string;
  params?: Record<string, FieldPatchValue>;
  resetParams?: string[];
  refs?: {
    uid?: string;
    assetId?: string;
    name?: string;
    purpose?: WorkingImage["purpose"];
    note?: string;
  }[];
  primaryRefUid?: string | null;
  mask?: null | { assetId?: string; rects?: Rect[] };
  boxes?: {
    uid?: string;
    id: string;
    role: BoxRole;
    rect: Rect;
    srcRect?: Rect;
    sourceId?: string;
    desc: string;
  }[];
  canvas?: { w: number; h: number };
  layoutEnabled?: boolean;
  compressEnabled?: boolean;
  maxInputEdge?: number;
  repeatCount?: number;
}

const PATCH_KEYS = [
  "intent",
  "modelId",
  "provider",
  "prompt",
  "params",
  "resetParams",
  "refs",
  "primaryRefUid",
  "mask",
  "boxes",
  "canvas",
  "layoutEnabled",
  "compressEnabled",
  "maxInputEdge",
  "repeatCount",
];
const REF_KEYS = ["uid", "assetId", "name", "purpose", "note"];
const BOX_KEYS = ["uid", "id", "role", "rect", "srcRect", "sourceId", "desc"];
const ROLES: BoxRole[] = ["new", "modify", "anchor", "move", "remove", "place"];
const SOURCE_ROLES: BoxRole[] = ["move", "anchor", "remove"];
const PURPOSES: WorkingImage["purpose"][] = [
  "reference",
  "style",
  "subject",
  "composition",
  "custom",
];
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BOX_ID_RE = /^[A-Za-z0-9_]+$/;
const MAX_REFS = 32;
const MAX_BOXES = 100;
const MAX_MASK_RECTS = 100;

export interface PatchIO {
  readAsset: (assetId: string) => Promise<ImportedImage>;
  maskFromRects: (image: WorkingImage, rects: Rect[]) => WorkingImage;
}

function readRect(value: unknown, what: string): Rect {
  const rect = checkKeys(value, ["x", "y", "w", "h"], what);
  for (const key of ["x", "y", "w", "h"]) {
    if (typeof rect[key] !== "number" || !Number.isFinite(rect[key] as number))
      fail("PATCH_INVALID", `${what}.${key} must be a finite number`);
  }
  if (
    (rect.x as number) < 0 ||
    (rect.y as number) < 0 ||
    (rect.w as number) <= 0 ||
    (rect.h as number) <= 0
  )
    fail("PATCH_INVALID", `${what} must be a positive rectangle`);
  return rect as unknown as Rect;
}

function readUuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value))
    fail("PATCH_INVALID", `${what} must be a UUID`);
  return value;
}

/** Existing identities accept any nonempty uid; UUID is only required when a new identity is minted. */
function readUid(value: unknown, what: string): string {
  if (typeof value !== "string" || !value || value.length > 100)
    fail("PATCH_INVALID", `${what} must be a nonempty string`);
  return value;
}

/** Produces the next draft for `patch` without committing anything. */
export async function prepareWorkspacePatch(
  previous: Draft,
  patch: WorkspacePatch,
  io: PatchIO,
  isCurrent: () => boolean,
): Promise<Draft> {
  checkKeys(patch, PATCH_KEYS, "patch");
  if (!Object.keys(patch).length)
    fail("PATCH_INVALID", "patch must change at least one field");
  let d: Draft = {
    ...previous,
    refs: [...previous.refs],
    boxes: [...previous.boxes],
  };

  // Route change comes first so every later check uses the target route's fields.
  if (patch.modelId !== undefined || patch.provider !== undefined) {
    const modelId = patch.modelId ?? d.modelId;
    const provider = (patch.provider ?? d.provider) as ProviderId;
    if (typeof modelId !== "string" || typeof provider !== "string")
      fail("PATCH_INVALID", "modelId and provider must be strings");
    const model = modelById(modelId);
    if (!model) fail("MODEL_UNKNOWN", "Unknown model", { modelId });
    if (!providers.some((p) => p.id === provider) || !model.routes[provider])
      fail("ROUTE_UNAVAILABLE", "This model has no route on that provider", {
        modelId,
        provider,
      });
    d = changeRoute(d, provider, modelId);
  }

  const fields = fieldsFor(d);

  if (patch.params !== undefined) {
    const raw = checkKeys(patch.params, Object.keys(fields), "params");
    const params: GenerateParams = { ...d.params };
    for (const [key, value] of Object.entries(raw)) {
      validateParamValue(key, fields[key]!, value);
      params[key] = value as GenerateParams[string];
    }
    d = { ...d, params };
  }
  if (patch.resetParams !== undefined) {
    if (!Array.isArray(patch.resetParams))
      fail("PATCH_INVALID", "resetParams must be an array");
    const params: GenerateParams = { ...d.params };
    const defaults = defaultsFor(d.modelId, d.provider);
    const seen = new Set<string>();
    for (const name of patch.resetParams) {
      if (
        typeof name !== "string" ||
        !name ||
        FORBIDDEN_KEYS.has(name) ||
        !Object.hasOwn(fields, name)
      )
        fail("PARAM_UNSUPPORTED", "resetParams contains unsupported field", {
          field: String(name),
        });
      if (patch.params && name in patch.params)
        fail("PATCH_INVALID", `${name} appears in both params and resetParams`);
      if (seen.has(name)) fail("PATCH_INVALID", `duplicate reset ${name}`);
      seen.add(name);
      if (name === "count") continue;
      if (defaults[name] !== undefined) params[name] = defaults[name];
      else delete params[name];
    }
    d = { ...d, params };
  }

  // An explicitly patched aspectRatio survives the "auto" default that
  // setPrimaryImage applies when a create draft turns into an edit draft.
  const patchedAspect =
    (patch.params !== undefined && Object.hasOwn(patch.params, "aspectRatio")) ||
    patch.resetParams?.includes("aspectRatio")
      ? d.params.aspectRatio
      : undefined;

  // The primary image identity is captured before any reference replacement.
  const oldPrimaryUid = primaryImage(d)?.uid ?? null;

  if (patch.refs !== undefined) {
    if (!Array.isArray(patch.refs))
      fail("PATCH_INVALID", "refs must be an array");
    if (patch.refs.length > MAX_REFS)
      fail("PATCH_INVALID", `refs accepts at most ${MAX_REFS} entries`);
    const next: WorkingImage[] = [];
    const usedUids = new Set<string>();
    const usedAssets = new Set<string>();
    for (const item of patch.refs) {
      const spec = checkKeys(item, REF_KEYS, "reference");
      const uid =
        spec.uid !== undefined ? readUid(spec.uid, "reference.uid") : undefined;
      const assetId =
        spec.assetId !== undefined
          ? readUuid(spec.assetId, "reference.assetId")
          : undefined;
      const existing = uid ? d.refs.find((r) => r.uid === uid) : undefined;
      let image: WorkingImage;
      if (existing) {
        // A supplied assetId must match the identity already attached to this
        // uid; a ref with no assetId never adopts unrelated bytes.
        if (assetId !== undefined && assetId !== existing.assetId)
          fail("REF_IDENTITY_CONFLICT", "uid already identifies another image", {
            uid,
          });
        image = { ...existing };
      } else if (assetId) {
        const already = d.refs.find((r) => r.assetId === assetId);
        if (already) {
          // The same asset keeps its existing identity in this draft.
          image = { ...already };
        } else {
          if (!isCurrent())
            fail(
              "VERSION_CONFLICT",
              "the workspace changed while loading images",
            );
          // A brand-new asset gets a fresh UUID identity; existing uids are
          // matched above without a format constraint.
          if (uid !== undefined && !UUID_RE.test(uid))
            fail(
              "PATCH_INVALID",
              "reference.uid must be a UUID for a new reference",
            );
          const loaded = await io.readAsset(assetId);
          image = {
            uid: uid ?? crypto.randomUUID(),
            dataUrl: loaded.dataUrl,
            width: loaded.width,
            height: loaded.height,
            name: loaded.name,
            assetId,
          };
        }
      } else if (uid) {
        fail("REF_UNKNOWN", "unknown uid requires an assetId", { uid });
      } else {
        fail("REF_INVALID", "a reference needs a uid or an assetId");
      }
      if (spec.name !== undefined) {
        if (typeof spec.name !== "string" || spec.name.length > 240)
          fail("PATCH_INVALID", "reference name must be a short string");
        image.name = spec.name;
      }
      if (spec.purpose !== undefined) {
        if (
          typeof spec.purpose !== "string" ||
          !PURPOSES.includes(spec.purpose as WorkingImage["purpose"])
        )
          fail("PATCH_INVALID", "reference purpose is not supported");
        image.purpose = spec.purpose as WorkingImage["purpose"];
      }
      if (spec.note !== undefined) {
        if (typeof spec.note !== "string" || spec.note.length > 10000)
          fail("PATCH_INVALID", "reference note is too long");
        image.note = spec.note;
      }
      if (image.uid === undefined || usedUids.has(image.uid))
        fail("REF_DUPLICATE", "duplicate reference uid", { uid: image.uid });
      usedUids.add(image.uid);
      if (image.assetId) {
        if (usedAssets.has(image.assetId))
          fail("REF_DUPLICATE", "duplicate reference asset", {
            assetId: image.assetId,
          });
        usedAssets.add(image.assetId);
      }
      next.push(image);
    }
    if (!isCurrent())
      fail("VERSION_CONFLICT", "the workspace changed while loading images");
    // reorderRefs remaps the exact <ref_image_N> prompt tags to the new order.
    d = reorderRefs(d, next);
  }

  // Resolve the final primary before the mask is considered: explicit selector,
  // else the retained old primary, else the first reference on edit drafts.
  let finalPrimaryUid: string | null = null;
  if (patch.primaryRefUid !== undefined) {
    if (patch.primaryRefUid === null) {
      if (d.intent === "edit")
        fail("PRIMARY_REQUIRED", "edit intent needs a primary image");
      d = { ...d, baseId: null };
    } else {
      finalPrimaryUid = readUid(patch.primaryRefUid, "primaryRefUid");
      if (!d.refs.some((r) => r.uid === finalPrimaryUid))
        fail("REF_UNKNOWN", "primaryRefUid is not a reference uid", {
          uid: finalPrimaryUid,
        });
    }
  } else if (d.intent === "edit") {
    finalPrimaryUid =
      oldPrimaryUid && d.refs.some((r) => r.uid === oldPrimaryUid)
        ? oldPrimaryUid
        : (d.refs[0]?.uid ?? null);
  }
  if (finalPrimaryUid) {
    // A refs-only replacement that drops the old primary still counts as a
    // primary change even when the fallback makes it look already applied.
    const changed = oldPrimaryUid !== finalPrimaryUid;
    if (changed && d.mask) {
      // The old mask protects the old image; only an explicit mask change
      // may clear it before the primary moves to different bytes.
      if (patch.mask === undefined)
        fail(
          "PRIMARY_MASK_CONFLICT",
          "changing the primary image while a mask exists requires an explicit mask",
        );
      d = { ...d, mask: null, maskRects: [] };
    }
    const needsApply =
      d.baseId !== finalPrimaryUid || d.refs[0]?.uid !== finalPrimaryUid;
    if (needsApply) {
      // Reordering references around the same primary keeps its mask: the
      // identical bytes are detached for the move and restored afterwards.
      const keepMask = !changed ? d.mask : null;
      const keepRects = !changed ? (d.maskRects ?? []) : [];
      if (keepMask) d = { ...d, mask: null };
      try {
        d = setPrimaryImage(d, finalPrimaryUid);
      } catch (e) {
        fail("PRIMARY_MASK_CONFLICT", String(e));
      }
      if (keepMask) d = { ...d, mask: keepMask, maskRects: keepRects };
      if (patchedAspect !== undefined && d.params.aspectRatio === "auto")
        d = { ...d, params: { ...d.params, aspectRatio: patchedAspect } };
    }
  } else if (d.intent === "edit" && !d.refs.length) {
    d = { ...d, baseId: null };
  }

  if (patch.mask !== undefined) {
    const route = routeFor(d);
    if (route && !route.mask && patch.mask !== null)
      fail("MASK_UNSUPPORTED", "this route does not accept a mask");
    if (patch.mask === null) {
      d = { ...d, mask: null, maskRects: [] };
    } else {
      const primary = primaryImage(d) ?? d.refs[0];
      if (!primary) fail("MASK_NO_PRIMARY", "a mask needs a primary image");
      const spec = checkKeys(patch.mask, ["assetId", "rects"], "mask");
      if (spec.assetId !== undefined && spec.rects !== undefined)
        fail("PATCH_INVALID", "mask accepts assetId or rects, not both");
      if (spec.assetId !== undefined) {
        const assetId = readUuid(spec.assetId, "mask.assetId");
        if (!isCurrent())
          fail("VERSION_CONFLICT", "the workspace changed while loading images");
        const loaded = await io.readAsset(assetId);
        if (!loaded.dataUrl.startsWith("data:image/png"))
          fail("MASK_FORMAT", "the mask asset must be a PNG image");
        if (loaded.width !== primary.width || loaded.height !== primary.height)
          fail(
            "MASK_DIMENSIONS",
            "the mask must match the primary image dimensions",
            { width: loaded.width, height: loaded.height },
          );
        d = {
          ...d,
          mask: {
            uid: crypto.randomUUID(),
            dataUrl: loaded.dataUrl,
            width: loaded.width,
            height: loaded.height,
            name: loaded.name,
            assetId,
          },
          maskRects: [],
        };
      } else if (spec.rects !== undefined) {
        if (!Array.isArray(spec.rects) || spec.rects.length > MAX_MASK_RECTS)
          fail("PATCH_INVALID", "mask rects must be an array");
        const rects = spec.rects.map((r, i) => readRect(r, `mask.rects[${i}]`));
        for (const r of rects)
          if (r.x + r.w > primary.width || r.y + r.h > primary.height)
            fail("MASK_BOUNDS", "mask rects must stay inside the primary image");
        d = {
          ...d,
          mask: io.maskFromRects(primary, rects),
          maskRects: rects,
        };
      } else {
        fail("PATCH_INVALID", "mask needs an assetId or rects");
      }
    }
  }

  // One sizing normalization, exactly like a user edit; an explicit canvas
  // then overrides it so explicit box rects stay in the agent's coordinates.
  d = normalizeDraftChange(previous, d);

  if (patch.canvas !== undefined) {
    const canvas = checkKeys(patch.canvas, ["w", "h"], "canvas");
    if (
      !Number.isInteger(canvas.w) ||
      !Number.isInteger(canvas.h) ||
      (canvas.w as number) < 1 ||
      (canvas.h as number) < 1 ||
      (canvas.w as number) > 16384 ||
      (canvas.h as number) > 16384 ||
      (canvas.w as number) * (canvas.h as number) > 64_000_000
    )
      fail("PATCH_INVALID", "canvas is outside its bounds");
    d = resizeCanvas(d, { w: canvas.w as number, h: canvas.h as number });
  }
  if (patch.boxes !== undefined) {
    if (!Array.isArray(patch.boxes) || patch.boxes.length > MAX_BOXES)
      fail("PATCH_INVALID", `boxes accepts at most ${MAX_BOXES} entries`);
    if (patch.boxes.length && d.family !== "flux")
      fail("LAYOUT_UNSUPPORTED", "regions are only supported on FLUX routes");
    const seen = new Set<string>();
    const seenUids = new Set<string>();
    const boxes: Box[] = patch.boxes.map((item, i) => {
      const spec = checkKeys(item, BOX_KEYS, `boxes[${i}]`);
      if (
        typeof spec.id !== "string" ||
        !BOX_ID_RE.test(spec.id) ||
        spec.id.length > 100
      )
        fail("PATCH_INVALID", `boxes[${i}].id is invalid`);
      if (seen.has(spec.id))
        fail("PATCH_INVALID", `duplicate box id ${spec.id}`);
      seen.add(spec.id);
      if (typeof spec.role !== "string" || !ROLES.includes(spec.role as BoxRole))
        fail("PATCH_INVALID", `boxes[${i}].role is invalid`);
      const rect = readRect(spec.rect, `boxes[${i}].rect`);
      if (rect.x + rect.w > d.canvas.w || rect.y + rect.h > d.canvas.h)
        fail("PATCH_INVALID", `boxes[${i}].rect is outside the canvas`);
      let sourceId: string | undefined;
      let srcRect: Rect | undefined;
      if (spec.sourceId !== undefined) {
        if (typeof spec.sourceId !== "string")
          fail("PATCH_INVALID", `boxes[${i}].sourceId is invalid`);
        const source = d.refs.find((r) => r.uid === spec.sourceId);
        if (!source)
          fail("PATCH_INVALID", `boxes[${i}].sourceId is not a reference uid`);
        sourceId = source.uid;
        if (spec.srcRect !== undefined) {
          srcRect = readRect(spec.srcRect, `boxes[${i}].srcRect`);
          if (
            srcRect.x + srcRect.w > source.width ||
            srcRect.y + srcRect.h > source.height
          )
            fail(
              "PATCH_INVALID",
              `boxes[${i}].srcRect is outside its source image`,
            );
        }
      } else if (spec.srcRect !== undefined)
        fail("PATCH_INVALID", `boxes[${i}].srcRect needs a sourceId`);
      if (SOURCE_ROLES.includes(spec.role as BoxRole)) {
        if (!sourceId)
          fail("PATCH_INVALID", `boxes[${i}].role ${spec.role} needs a sourceId`);
        if (!srcRect) {
          const source = d.refs.find((r) => r.uid === sourceId)!;
          srcRect = {
            x: (rect.x / d.canvas.w) * source.width,
            y: (rect.y / d.canvas.h) * source.height,
            w: (rect.w / d.canvas.w) * source.width,
            h: (rect.h / d.canvas.h) * source.height,
          };
        }
      }
      if (typeof spec.desc !== "string" || spec.desc.length > 10000)
        fail("PATCH_INVALID", `boxes[${i}].desc is invalid`);
      const uid =
        spec.uid !== undefined
          ? readUuid(spec.uid, `boxes[${i}].uid`)
          : crypto.randomUUID();
      if (seenUids.has(uid))
        fail("PATCH_INVALID", `duplicate box uid ${uid}`);
      seenUids.add(uid);
      const prior = d.boxes.find((b) => b.uid === uid);
      return {
        uid,
        color: prior?.color,
        id: spec.id,
        role: spec.role as BoxRole,
        rect,
        ...(srcRect ? { srcRect } : {}),
        ...(sourceId ? { sourceId } : {}),
        desc: spec.desc,
      };
    });
    d = { ...d, boxes };
  }
  if (patch.layoutEnabled !== undefined) {
    if (typeof patch.layoutEnabled !== "boolean")
      fail("PATCH_INVALID", "layoutEnabled must be a boolean");
    if (patch.layoutEnabled && d.family !== "flux")
      fail("LAYOUT_UNSUPPORTED", "layout is only supported on FLUX routes");
    if (patch.layoutEnabled === false && requiresLayout(d))
      fail("LAYOUT_REQUIRED", "this route requires layout for text-to-image");
    d = { ...d, layoutEnabled: patch.layoutEnabled };
  }
  if (patch.compressEnabled !== undefined) {
    if (typeof patch.compressEnabled !== "boolean")
      fail("PATCH_INVALID", "compressEnabled must be a boolean");
    d = { ...d, compressEnabled: patch.compressEnabled };
  }
  if (patch.maxInputEdge !== undefined) {
    if (
      !Number.isInteger(patch.maxInputEdge) ||
      patch.maxInputEdge < 256 ||
      patch.maxInputEdge > 8192
    )
      fail("PATCH_INVALID", "maxInputEdge must be an integer 256-8192");
    d = { ...d, maxInputEdge: patch.maxInputEdge };
  }
  if (patch.repeatCount !== undefined) {
    if (
      !Number.isInteger(patch.repeatCount) ||
      patch.repeatCount < 1 ||
      patch.repeatCount > 20
    )
      fail("PATCH_INVALID", "repeatCount must be an integer 1-20");
    d = { ...d, repeatCount: patch.repeatCount };
  }
  // A supplied prompt describes the final reference order, so it lands last.
  if (patch.prompt !== undefined) {
    if (typeof patch.prompt !== "string" || patch.prompt.length > 100000)
      fail("PATCH_INVALID", "prompt must be a string");
    d = { ...d, prompt: patch.prompt };
  }
  if (patch.intent !== undefined && patch.intent !== d.intent)
    fail("PATCH_INVALID", "patch.intent does not match the target draft");
  if (!isCurrent())
    fail("VERSION_CONFLICT", "the workspace changed during the patch");
  return withIds(d);
}
