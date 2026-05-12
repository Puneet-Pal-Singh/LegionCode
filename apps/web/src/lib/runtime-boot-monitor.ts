const RUNTIME_BOOT_CHANGED_EVENT = "shadowbox:runtime-boot-changed";
const RUNTIME_BOOT_STORAGE_KEY = "shadowbox:brain-runtime-boot-id";

type RuntimeBootListener = (bootId: string) => void;

const listeners = new Set<RuntimeBootListener>();

export function observeRuntimeBootId(bootId: string | null): void {
  const normalizedBootId = bootId?.trim();
  if (!normalizedBootId) {
    return;
  }

  const previousBootId = readStoredBootId();
  if (previousBootId === undefined) {
    return;
  }
  if (previousBootId === normalizedBootId) {
    return;
  }

  if (!writeStoredBootId(normalizedBootId)) {
    return;
  }
  if (previousBootId) {
    notifyRuntimeBootChanged(normalizedBootId);
  }
}

export function subscribeRuntimeBootChanges(
  listener: RuntimeBootListener,
): () => void {
  listeners.add(listener);
  const handleWindowEvent = (event: Event): void => {
    const detail = (event as CustomEvent<{ bootId?: unknown }>).detail;
    if (typeof detail?.bootId === "string") {
      notifyListener(listener, detail.bootId);
    }
  };
  window.addEventListener(RUNTIME_BOOT_CHANGED_EVENT, handleWindowEvent);

  return () => {
    listeners.delete(listener);
    window.removeEventListener(RUNTIME_BOOT_CHANGED_EVENT, handleWindowEvent);
  };
}

export function _resetRuntimeBootMonitorForTests(): void {
  listeners.clear();
  clearStoredBootId();
}

function notifyRuntimeBootChanged(bootId: string): void {
  listeners.forEach((listener) => notifyListener(listener, bootId));
  window.dispatchEvent(
    new CustomEvent(RUNTIME_BOOT_CHANGED_EVENT, { detail: { bootId } }),
  );
}

function readStoredBootId(): string | null | undefined {
  try {
    return localStorage.getItem(RUNTIME_BOOT_STORAGE_KEY);
  } catch (error) {
    console.warn(
      "[runtime-boot-monitor/observe] Failed to read boot id from localStorage:",
      error,
    );
    return undefined;
  }
}

function writeStoredBootId(bootId: string): boolean {
  try {
    localStorage.setItem(RUNTIME_BOOT_STORAGE_KEY, bootId);
    return true;
  } catch (error) {
    console.error(
      "[runtime-boot-monitor/observe] Failed to persist boot id to localStorage:",
      error,
    );
    return false;
  }
}

function clearStoredBootId(): void {
  try {
    localStorage.removeItem(RUNTIME_BOOT_STORAGE_KEY);
  } catch (error) {
    console.warn(
      "[runtime-boot-monitor/reset] Failed to clear boot id from localStorage:",
      error,
    );
  }
}

function notifyListener(listener: RuntimeBootListener, bootId: string): void {
  try {
    listener(bootId);
  } catch (error) {
    console.error("[runtime-boot-monitor/notify] Listener error:", error);
  }
}
