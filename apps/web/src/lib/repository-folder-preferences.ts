export interface RepositoryFolderPreferences {
  readonly labels: Readonly<Record<string, string>>;
  readonly hiddenRepositoryIds: readonly string[];
}

const STORAGE_KEY = "legioncode:repository-folder-preferences:v1";
const EMPTY_PREFERENCES: RepositoryFolderPreferences = {
  labels: {},
  hiddenRepositoryIds: [],
};

export function loadRepositoryFolderPreferences(): RepositoryFolderPreferences {
  try {
    const serialized = localStorage.getItem(STORAGE_KEY);
    if (!serialized) return EMPTY_PREFERENCES;

    const parsed: unknown = JSON.parse(serialized);
    if (!isRepositoryFolderPreferences(parsed)) return EMPTY_PREFERENCES;
    return parsed;
  } catch {
    return EMPTY_PREFERENCES;
  }
}

export function setRepositoryFolderHidden(
  preferences: RepositoryFolderPreferences,
  repositoryId: string,
  hidden: boolean,
): RepositoryFolderPreferences {
  const hiddenIds = new Set(preferences.hiddenRepositoryIds);
  if (hidden) hiddenIds.add(repositoryId);
  else hiddenIds.delete(repositoryId);
  return {
    ...preferences,
    hiddenRepositoryIds: Array.from(hiddenIds),
  };
}

export function setRepositoryFolderLabel(
  preferences: RepositoryFolderPreferences,
  repositoryId: string,
  label: string,
): RepositoryFolderPreferences {
  const labels = { ...preferences.labels };
  const normalizedLabel = label.trim();
  if (normalizedLabel.length === 0) delete labels[repositoryId];
  else labels[repositoryId] = normalizedLabel;
  return { ...preferences, labels };
}

export function persistRepositoryFolderPreferences(
  preferences: RepositoryFolderPreferences,
): void {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      const parsed: unknown = JSON.parse(existing);
      if (!isRepositoryFolderPreferences(parsed)) return;
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        labels: preferences.labels,
        hiddenRepositoryIds: preferences.hiddenRepositoryIds,
      }),
    );
  } catch {
    // Keep the current UI preference in memory if browser storage is unavailable.
  }
}

function isRepositoryFolderPreferences(
  value: unknown,
): value is RepositoryFolderPreferences {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        key !== "version" &&
        key !== "labels" &&
        key !== "hiddenRepositoryIds",
    )
  ) {
    return false;
  }
  if (
    record.version !== 1 ||
    !record.labels ||
    typeof record.labels !== "object" ||
    Array.isArray(record.labels) ||
    !Array.isArray(record.hiddenRepositoryIds)
  ) {
    return false;
  }
  return (
    Object.values(record.labels).every((label) => typeof label === "string") &&
    record.hiddenRepositoryIds.every(
      (repositoryId) => typeof repositoryId === "string",
    )
  );
}
