import {
  ReasoningEffortSchema,
  type ReasoningEffort,
} from "@repo/shared-types";

export type ReasoningEffortSelection = "default" | ReasoningEffort;

const STORAGE_PREFIX = "legioncode:reasoning-effort:";

export function loadReasoningEffortSelection(
  providerId: string,
  modelId: string,
): ReasoningEffortSelection {
  try {
    const value = localStorage.getItem(storageKey(providerId, modelId));
    if (value === "default") return value;
    const parsed = ReasoningEffortSchema.safeParse(value);
    return parsed.success ? parsed.data : "default";
  } catch {
    return "default";
  }
}

export function saveReasoningEffortSelection(
  providerId: string,
  modelId: string,
  value: ReasoningEffortSelection,
): void {
  try {
    localStorage.setItem(storageKey(providerId, modelId), value);
  } catch {
    // UI preference storage can be unavailable without blocking a turn.
  }
}

export function resolveReasoningEffortForRequest(
  providerId: string,
  modelId: string,
  providerEfforts?: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  const selection = loadReasoningEffortSelection(providerId, modelId);
  if (selection === "default") {
    return undefined;
  }
  if (!providerEfforts?.includes(selection)) {
    saveReasoningEffortSelection(providerId, modelId, "default");
    return undefined;
  }
  return selection;
}

function storageKey(providerId: string, modelId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
}
