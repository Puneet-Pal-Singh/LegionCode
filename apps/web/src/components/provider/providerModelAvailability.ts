import { type ProviderModelOption } from "../../services/api/providerClient.js";

export function isProviderModelAvailable(model: ProviderModelOption): boolean {
  return (model.availability ?? "available") === "available";
}

export function getProviderModelUnavailableReason(
  model: ProviderModelOption,
): string {
  return model.unavailableReason ?? "Unavailable for runtime selection";
}
