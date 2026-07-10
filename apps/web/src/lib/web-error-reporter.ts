import { createLogger } from "@repo/observability";

const logger = createLogger({
  service: "web",
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_GIT_SHA,
  context: { clientInstanceId: getClientInstanceId() },
});

export function reportWebException(
  event: string,
  error: unknown,
  context: Readonly<Record<string, unknown>> = {},
): void {
  logger.captureException(event, error, context);
}

function getClientInstanceId(): string {
  if (typeof window === "undefined") return "server";
  const storageKey = "legioncode.webObservabilityInstanceId";

  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return "storage-unavailable";
  }
}
