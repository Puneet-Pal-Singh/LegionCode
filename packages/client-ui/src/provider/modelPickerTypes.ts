import type {
  BYOKDiscoveredProviderModel,
  BYOKDiscoveredProviderModelsMetadata,
  BYOKDiscoveredProviderModelsQuery,
} from "@repo/shared-types";

/** Presentation consumes canonical discovery metadata; hosts retain discovery/selection ownership. */
export type ModelPickerModel = Pick<
  BYOKDiscoveredProviderModel,
  | "id"
  | "name"
  | "availability"
  | "unavailableReason"
  | "inputModalities"
  | "capabilityMetadata"
  | "capabilities"
  | "contextWindow"
  | "pricing"
  | "description"
>;
export type ModelPickerDiscoveryView =
  BYOKDiscoveredProviderModelsQuery["view"];
export type ModelPickerModelsMetadata = Omit<
  BYOKDiscoveredProviderModelsMetadata,
  "status"
> &
  Partial<Pick<BYOKDiscoveredProviderModelsMetadata, "status">>;
