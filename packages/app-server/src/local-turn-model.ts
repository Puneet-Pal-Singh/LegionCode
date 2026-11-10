import {
  BYOKDiscoveredProviderModelSchema,
  type BYOKDiscoveredProviderModel,
} from "@repo/shared-types";
import type { ProviderSelection } from "./local-providers.js";
import { AppServerOperationError } from "./server.js";

/** Private per-attempt catalog snapshot. Runtime routing validates the route;
 * volatile discovery metadata never becomes durable request identity. */
export function captureLocalTurnModel(
  input: unknown,
  selection: Pick<ProviderSelection, "providerId" | "modelId">,
): BYOKDiscoveredProviderModel {
  const parsed = BYOKDiscoveredProviderModelSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.providerId !== selection.providerId ||
    parsed.data.id !== selection.modelId ||
    parsed.data.availability !== "available" ||
    parsed.data.runtimeRoute === undefined
  ) {
    throw new AppServerOperationError(
      409,
      "conflict",
      "The selected provider model is unavailable",
      "local_model_unavailable",
      false,
    );
  }
  return freezeSnapshot(parsed.data);
}

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
