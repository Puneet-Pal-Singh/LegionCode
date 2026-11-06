import { FollowLifecycleRequestSchema } from "@repo/platform-protocol";
import type { AppServerClient } from "./app-server-client.js";
import { PlatformClientOperationError } from "./errors.js";
import { followLifecycleEvents } from "./lifecycle-continuation.js";
import { mapHostedLifecycleError } from "./http-transport.js";
import type { PlatformClient, PlatformClientOperationOptions } from "./types.js";

/** Portable replay/continuation over an App Server client, including Desktop IPC. */
export function createAppServerLifecycleClient(
  client: Pick<AppServerClient, "replayLifecycleEvents">,
): Pick<PlatformClient, "replayLifecycleEvents" | "followTurnLifecycle"> {
  const assertNotAborted = (options?: PlatformClientOperationOptions) => {
    if (options?.signal?.aborted) {
      throw new PlatformClientOperationError("ABORTED", "Lifecycle replay was aborted", false);
    }
  };
  const replay: PlatformClient["replayLifecycleEvents"] = async (request, options) => {
    assertNotAborted(options);
    try {
      const result = await awaitReplay(client.replayLifecycleEvents(request), options?.signal);
      assertNotAborted(options);
      return result;
    } catch (error) {
      assertNotAborted(options);
      if (error instanceof PlatformClientOperationError) throw error;
      throw mapHostedLifecycleError(error, "turn/lifecycleEvents");
    }
  };
  return {
    replayLifecycleEvents: replay,
    async *followTurnLifecycle(request, options) {
      yield* followLifecycleEvents({
        request: FollowLifecycleRequestSchema.parse(request), options, replay,
      });
    },
  };
}

/** IPC may not cancel an already-dispatched read. Bound it and suppress late results. */
function awaitReplay<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(
      new PlatformClientOperationError("ABORTED", "Lifecycle replay was aborted", false),
    ));
    const timer = setTimeout(() => finish(() => reject(
      new PlatformClientOperationError("NETWORK_ERROR", "Lifecycle replay timed out", true, undefined, 0),
    )), 5_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    operation.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
