import type { ProviderSelectionSnapshot } from "@legioncode/sdk";

const SESSION_SCOPED_SELECTION_STORAGE_KEY_PREFIX =
  "provider:session-scoped-selection:";

export function writeSessionScopedSelection(
  sessionId: string,
  selection: ProviderSelectionSnapshot,
): void {
  try {
    localStorage.setItem(
      buildSessionScopedSelectionStorageKey(sessionId),
      JSON.stringify(selection),
    );
  } catch (error) {
    console.warn(
      "[provider/store] failed to persist session-scoped selection",
      error,
    );
  }
}

export function readSessionScopedSelection(
  sessionId: string,
): ProviderSelectionSnapshot | null {
  const key = buildSessionScopedSelectionStorageKey(sessionId);
  try {
    const serialized = localStorage.getItem(key);
    if (serialized !== null) {
      const parsed: unknown = JSON.parse(serialized);
      if (isProviderSelectionSnapshot(parsed)) return parsed;
    }
  } catch (error) {
    console.warn(
      "[provider/store] failed to restore session-scoped selection",
      error,
    );
  }

  try {
    const serialized = sessionStorage.getItem(key);
    if (!serialized) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (!isProviderSelectionSnapshot(parsed)) return null;
    return parsed;
  } catch (error) {
    console.warn(
      "[provider/store] failed to restore legacy session-scoped selection",
      error,
    );
    return null;
  }
}

function buildSessionScopedSelectionStorageKey(sessionId: string): string {
  return `${SESSION_SCOPED_SELECTION_STORAGE_KEY_PREFIX}${sessionId}`;
}

function isProviderSelectionSnapshot(
  value: unknown,
): value is ProviderSelectionSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    isNullableString(record.selectedProviderId) &&
    isNullableString(record.selectedCredentialId) &&
    isNullableString(record.selectedModelId)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
