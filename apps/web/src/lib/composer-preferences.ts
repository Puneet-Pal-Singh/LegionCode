import { useSyncExternalStore } from "react";

const STORAGE_KEY = "legioncode:composer-preferences";
const CHANGE_EVENT = "legioncode:composer-preferences-changed";

export interface ComposerPreferences {
  readonly showContextWindowUsage: boolean;
}

const DEFAULT_PREFERENCES: ComposerPreferences = {
  showContextWindowUsage: true,
};

export function readComposerPreferences(): ComposerPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const value = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "{}",
    ) as {
      showContextWindowUsage?: unknown;
    };
    return {
      showContextWindowUsage:
        typeof value.showContextWindowUsage === "boolean"
          ? value.showContextWindowUsage
          : DEFAULT_PREFERENCES.showContextWindowUsage,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function updateComposerPreferences(
  patch: Partial<ComposerPreferences>,
): void {
  const next = { ...readComposerPreferences(), ...patch };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useComposerPreferences(): ComposerPreferences {
  return useSyncExternalStore(
    subscribe,
    readSnapshot,
    () => DEFAULT_PREFERENCES,
  );
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

let cachedRaw: string | null | undefined;
let cachedSnapshot = DEFAULT_PREFERENCES;

function readSnapshot(): ComposerPreferences {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;
  cachedSnapshot = readComposerPreferences();
  return cachedSnapshot;
}
