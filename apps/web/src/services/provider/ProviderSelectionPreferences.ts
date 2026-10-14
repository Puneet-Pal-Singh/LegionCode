export interface ProviderSelectionSnapshot {
  selectedProviderId: string | null;
  selectedCredentialId: string | null;
  selectedModelId: string | null;
}

const SESSION_SCOPED_SELECTION_STORAGE_KEY_PREFIX =
  "provider:session-scoped-selection:";

export function writeSessionScopedSelection(
  sessionId: string,
  selection: ProviderSelectionSnapshot,
): void {
  try {
    sessionStorage.setItem(
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
  try {
    const serialized = sessionStorage.getItem(
      buildSessionScopedSelectionStorageKey(sessionId),
    );
    if (!serialized) {
      return null;
    }

    const parsed: unknown = JSON.parse(serialized);
    if (!isProviderSelectionSnapshot(parsed)) {
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn(
      "[provider/store] failed to restore session-scoped selection",
      error,
    );
    return null;
  }
}

function buildSessionScopedSelectionStorageKey(sessionId: string): string {
  return `${SESSION_SCOPED_SELECTION_STORAGE_KEY_PREFIX}${sessionId}`;
}

export function clearPersistedSessionScopedSelections(): void {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key && key.startsWith(SESSION_SCOPED_SELECTION_STORAGE_KEY_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      sessionStorage.removeItem(key);
    }
  } catch (error) {
    console.warn(
      "[provider/store] failed to clear persisted session-scoped selections",
      error,
    );
  }
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
