import type {
  AppServerTransport,
} from "@legioncode/sdk/platform/app-server-client";
import type { DesktopApi } from "../shared/desktop-api";

/** Adapts callback-only preload IPC to the SDK's renderer-local continuation stream. */
export function createDesktopAppServerTransport(
  desktop: DesktopApi,
): AppServerTransport {
  return {
    request: (envelope) => desktop.request(envelope),
    subscribe: async (request, onEvent, onError, options) => {
      if (options?.signal?.aborted) return () => undefined;

      let closed = false;
      let unsubscribe: (() => void) | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        options?.signal?.removeEventListener("abort", close);
        unsubscribe?.();
      };
      options?.signal?.addEventListener("abort", close, { once: true });

      try {
        const release = await desktop.subscribeContinuation(request, (message) => {
          if (message.operation === "failed") {
            onError(new Error("Desktop Turn continuation is unavailable"));
            close();
            return;
          }
          onEvent(message.event);
        });
        unsubscribe = release;
        if (closed) release();
        return close;
      } catch {
        close();
        throw new Error("Desktop Turn continuation is unavailable");
      }
    },
  };
}
