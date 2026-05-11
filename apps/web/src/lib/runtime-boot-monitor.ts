const RUNTIME_BOOT_CHANGED_EVENT = "shadowbox:runtime-boot-changed";
const RUNTIME_BOOT_STORAGE_KEY = "shadowbox:brain-runtime-boot-id";

type RuntimeBootListener = (bootId: string) => void;

const listeners = new Set<RuntimeBootListener>();

export function observeRuntimeBootId(bootId: string | null): void {
  const normalizedBootId = bootId?.trim();
  if (!normalizedBootId) {
    return;
  }

  const previousBootId = localStorage.getItem(RUNTIME_BOOT_STORAGE_KEY);
  if (previousBootId === normalizedBootId) {
    return;
  }

  localStorage.setItem(RUNTIME_BOOT_STORAGE_KEY, normalizedBootId);
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
      listener(detail.bootId);
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
  localStorage.removeItem(RUNTIME_BOOT_STORAGE_KEY);
}

function notifyRuntimeBootChanged(bootId: string): void {
  listeners.forEach((listener) => listener(bootId));
  window.dispatchEvent(
    new CustomEvent(RUNTIME_BOOT_CHANGED_EVENT, { detail: { bootId } }),
  );
}
