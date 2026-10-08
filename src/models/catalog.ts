import raw from "../../shared/model-catalog.json";
import { m } from "../i18n";
import { fieldLabel } from "../labels";
import type {
  Draft,
  FamilyId,
  GenerateParams,
  ParamValue,
  ProviderId,
} from "../lib/types";

export interface FieldDefinition {
  label: string;
  kind: "enum" | "integer" | "boolean" | "text" | "size";
  values?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  minLength?: number;
  nullable?: boolean;
  allowAuto?: boolean;
  help?: string;
}
export interface ModelRoute {
  model: string;
  maxRefs: number;
  mask: boolean;
  parameters: Record<string, Partial<FieldDefinition>>;
  defaults?: GenerateParams;
  maxPixels?: number;
  minPrompt?: number;
  maxPrompt?: number;
  minPixels?: number;
  maxAspect?: number;
  dimensionsKey?: string;
  maxInputBytes?: number;
  maxInputPixels?: number;
  maxRequestBytes?: number;
  notes?: string;
  docs: string;
}
export interface ModelDefinition {
  id: string;
  family: FamilyId;
  label: string;
  routes: Partial<Record<ProviderId, ModelRoute>>;
}
export interface FamilyDefinition {
  id: FamilyId;
  label: string;
  description: string;
  defaultModel: string;
  defaults: GenerateParams;
}
export const catalog = raw as unknown as {
  checkedAt: string;
  providers: {
    id: ProviderId;
    label: string;
    envName: string;
    keyUrl: string;
  }[];
  families: FamilyDefinition[];
  models: ModelDefinition[];
  fields: Record<string, FieldDefinition>;
  fluxDimensions: Record<string, Record<string, [number, number]>>;
  imageDimensions: Record<
    string,
    Record<string, Record<string, [number, number]>>
  >;
};
export const families = catalog.families;
export const providers = catalog.providers;
export const modelById = (id: string) =>
  catalog.models.find((m) => m.id === id);
export const modelByAnyId = (id: string) =>
  catalog.models.find(
    (m) => m.id === id || Object.values(m.routes).some((r) => r?.model === id),
  );
export const familyById = (id: FamilyId) => families.find((f) => f.id === id)!;
export const routeFor = (d: Pick<Draft, "modelId" | "provider">) =>
  modelById(d.modelId)?.routes[d.provider];
export function fieldsFor(
  d: Pick<Draft, "modelId" | "provider">,
): Record<string, FieldDefinition> {
  const route = routeFor(d);
  return Object.fromEntries(
    Object.entries(route?.parameters ?? {}).map(([key, rule]) => [
      key,
      { ...catalog.fields[key], ...rule },
    ]),
  );
}
export function defaultsFor(
  modelId: string,
  provider: ProviderId,
): GenerateParams {
  const model = modelById(modelId)!;
  const defaults = {
    ...familyById(model.family).defaults,
    ...model.routes[provider]?.defaults,
  };
  return pickParams(modelId, provider, defaults);
}
/** 参数有意按路由白名单投影，草稿可保留其他路由的设置，但不会隐式发送。 */
export function pickParams(
  modelId: string,
  provider: ProviderId,
  params: GenerateParams,
): GenerateParams {
  return Object.fromEntries(
    Object.keys(modelById(modelId)?.routes[provider]?.parameters ?? {}).flatMap(
      (key) => {
        const value = params[key];
        return value === undefined || value === null ? [] : [[key, value]];
      },
    ),
  );
}
export function changeRoute(
  d: Draft,
  provider: ProviderId,
  modelId = d.modelId,
): Draft {
  const family = modelById(modelId)!.family;
  const next = { ...d, family, provider, modelId };
  // Keep unsupported data (including masks and refs) for returning to the previous route.
  // Each route keeps its own values; new routes project shared values with visible feedback.
  const defaults = defaultsFor(modelId, provider);
  const routeKey = (id: string, p: ProviderId) => id + ":" + p;
  const routeSettings = {
    ...d.routeSettings,
    [routeKey(d.modelId, d.provider)]: { ...d.params },
  };
  const params = {
    ...defaults,
    ...(routeSettings[routeKey(modelId, provider)] ??
      (family === d.family ? d.params : {})),
  };
  for (const [key, field] of Object.entries(fieldsFor(next))) {
    const value = params[key];
    if (field.kind === "integer" && value === null && !field.nullable)
      params[key] = defaults[key];
    if (
      field.kind === "enum" &&
      value != null &&
      !field.values?.includes(String(value))
    )
      params[key] = defaults[key];
    if (
      field.kind === "integer" &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      params[key] = Math.max(
        field.min ?? 0,
        Math.min(field.max ?? Infinity, value),
      );
    if (field.kind === "size" && value === "auto" && !field.allowAuto)
      params[key] = defaults[key];
  }
  return {
    ...next,
    params,
    routeSettings,
    familyRoutes: {
      ...d.familyRoutes,
      [d.family]: { modelId: d.modelId, provider: d.provider },
      [family]: { modelId, provider },
    },
  };
}
export function validateFields(d: Draft): string[] {
  const route = routeFor(d);
  if (!route || modelById(d.modelId)?.family !== d.family)
    return [m.error_route_unavailable()];
  const errors: string[] = [];
  const merged = { ...defaultsFor(d.modelId, d.provider), ...d.params };
  for (const [key, f] of Object.entries(fieldsFor(d))) {
    if (
      (key === "outputCompression" && merged.outputFormat === "png") ||
      (key === "promptExtendMode" && merged.promptExtend === false)
    )
      continue;
    const v: ParamValue | undefined = merged[key];
    if (v === undefined || v === null) continue;
    const label = fieldLabel(key, f.label);
    if (f.kind === "enum" && !f.values?.includes(String(v)))
      errors.push(m.error_field_enum({ label, value: String(v) }));
    if (
      f.kind === "integer" &&
      (typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < (f.min ?? 0) ||
        v > (f.max ?? Infinity))
    )
      errors.push(
        m.error_field_integer({
          label,
          min: f.min ?? "undefined",
          max: f.max ?? "undefined",
        }),
      );
    if (f.kind === "boolean" && typeof v !== "boolean")
      errors.push(m.error_field_boolean({ label }));
    if (
      f.kind === "text" &&
      (typeof v !== "string" ||
        v.length > (f.maxLength ?? Infinity) ||
        (v.length > 0 && v.length < (f.minLength ?? 0)))
    )
      errors.push(m.error_field_text({ label }));
  }
  if (d.refs.length > route.maxRefs)
    errors.push(
      route.maxRefs === 0
        ? m.error_text_only_route()
        : m.error_too_many_refs({ count: route.maxRefs, current: d.refs.length }),
    );
  if (d.mask && !route.mask) errors.push(m.error_mask_unsupported());
  return errors;
}

/** Each concurrent request asks for one image; the footer owns total quantity. */
export function singleImageDraft(d: Draft): Draft {
  return fieldsFor(d).count ? { ...d, params: { ...d.params, count: 1 } } : d;
}
