import type { ModelPickerModel as ProviderModelOption } from "./modelPickerTypes.js";

export function isProviderModelAvailable(model: ProviderModelOption): boolean {
  return (model.availability ?? "available") === "available";
}

export function getProviderModelUnavailableReason(
  model: ProviderModelOption,
): string {
  return model.unavailableReason ?? "Unavailable for runtime selection";
}
