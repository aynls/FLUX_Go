import { m } from "./i18n";

const providers: Record<string, () => string> = {
  xai: m.provider_xai,
  openrouter: m.provider_openrouter,
  bfl: m.provider_bfl,
  comfy: m.provider_comfy,
  runware: m.provider_runware,
  google: m.provider_google,
  ark: m.provider_ark,
  byteplus: m.provider_byteplus,
};

const models: Record<string, () => string> = {
  "gpt-image-2.5-flare": m.model_flare,
  "openai/gpt-image-2.5-flare": m.model_flare,
  "openai:gpt-image@2.5-flare": m.model_flare,
  "gpt-image-2.5-sunburst": m.model_sunburst,
  "openai/gpt-image-2.5-sunburst": m.model_sunburst,
  "openai:gpt-image@2.5-sunburst": m.model_sunburst,
};

const fields: Record<string, () => string> = {
  thinkingLevel: m.field_thinkingLevel,
  includeThoughts: m.field_includeThoughts,
  searchMode: m.field_searchMode,
  responseText: m.field_responseText,
  resolution: m.field_resolution,
  aspectRatio: m.field_aspectRatio,
  safetyTolerance: m.field_safetyTolerance,
  grounding: m.field_grounding,
  version: m.field_version,
  quality: m.field_quality,
  size: m.field_size,
  background: m.field_background,
  outputFormat: m.field_outputFormat,
  outputCompression: m.field_outputCompression,
  moderation: m.field_moderation,
  count: m.field_count,
  width: m.field_width,
  height: m.field_height,
  seed: m.field_seed,
  negativePrompt: m.field_negativePrompt,
  promptExtend: m.field_promptExtend,
  promptExtendMode: m.field_promptExtendMode,
  watermark: m.field_watermark,
};

const help: Record<string, () => string> = {
  thinkingLevel: m.field_thinkingLevel_help,
  includeThoughts: m.field_includeThoughts_help,
  searchMode: m.field_searchMode_help,
  safetyTolerance: m.field_safetyTolerance_help,
  size: m.field_size_help,
  outputCompression: m.field_outputCompression_help,
  seed: m.field_seed_help,
};

const values: Record<string, () => string> = {
  auto: m.value_auto,
  minimal: m.value_minimal,
  none: m.state_none,
  web: m.value_web,
  images: m.value_images,
  web_images: m.value_web_images,
  low: m.value_low,
  medium: m.value_medium,
  high: m.value_high,
  xhigh: m.value_xhigh,
  max: m.value_max,
  opaque: m.value_opaque,
  transparent: m.value_transparent,
  direct: m.value_direct,
  agent: m.value_agent,
  latest: m.value_latest,
};

export function providerLabel(id: string | undefined) {
  if (!id) return "";
  return providers[id]?.() ?? id;
}

export function modelLabel(id: string | undefined, fallback = "") {
  if (!id) return fallback;
  return models[id]?.() ?? fallback;
}

export function fieldLabel(key: string, fallback = key) {
  return fields[key]?.() ?? fallback;
}

export function fieldHelp(key: string, provider?: string) {
  if (key === "quality" && provider === "xai") return m.field_quality_xai_help();
  return help[key]?.();
}

export function valueLabel(value: string) {
  return values[value]?.() ?? value;
}

export function requestStatus(status: string) {
  return (
    {
      queued: m.status_queued(),
      running: m.status_running(),
      ok: m.status_ok(),
      failed: m.status_failed(),
      skipped: m.status_skipped(),
      interrupted: m.status_interrupted(),
      cancelled: m.status_cancelled(),
      partial: m.status_partial(),
    }[status] ?? status
  );
}

export function historyPhase(phase: string) {
  return (
    {
      preparing: m.phase_preparing_assets(),
      submitting: m.phase_submitting(),
      queued: m.phase_provider_queue(),
      generating: m.phase_generating(),
      waiting: m.phase_waiting(),
      downloading: m.phase_downloading(),
      reasoning: m.phase_reasoning(),
      saving: m.phase_saving(),
    }[phase] ?? m.status_running()
  );
}

export function generationPhase(phase: string) {
  return (
    {
      preparing: m.phase_preparing_input(),
      submitting: m.phase_submit_request(),
      queued: m.phase_queued(),
      reasoning: m.phase_understanding(),
      generating: m.phase_generating(),
      waiting: m.phase_waiting(),
      downloading: m.phase_downloading(),
      saving: m.phase_saving_gallery(),
    }[phase] ?? phase
  );
}
