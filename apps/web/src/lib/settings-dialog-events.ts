export type SettingsSection = "general" | "connect" | "models" | "archived";

const OPEN_SETTINGS_EVENT = "shadowbox:open-settings";

interface OpenSettingsDetail {
  section?: SettingsSection;
}

export function dispatchOpenSettingsDialog(
  section: SettingsSection = "general",
): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, {
      detail: { section },
    }),
  );
}

export function subscribeToOpenSettingsDialog(
  listener: (section: SettingsSection) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handler = (event: Event): void => {
    const customEvent = event as CustomEvent<OpenSettingsDetail>;
    const section = customEvent.detail?.section ?? "general";
    listener(section);
  };

  window.addEventListener(OPEN_SETTINGS_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(OPEN_SETTINGS_EVENT, handler as EventListener);
  };
}
