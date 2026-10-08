import type { GenerateParams } from "../lib/types";
import { m } from "../i18n";
import { valueLabel } from "../labels";

export function displayValue(key: string, value: GenerateParams[string]) {
  if (value == null) return key === "seed" ? m.state_random() : m.state_provider_default();
  if (typeof value === "boolean") return value ? m.state_on() : m.state_off();
  return valueLabel(String(value));
}
