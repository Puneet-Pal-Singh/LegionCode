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
      const result = await awaitReplay(client.replayLifecycleEvents(request, { signal: options?.signal }), options?.signal);
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

/** IPC may not cancel an already-dispatched read. Reject promptly on abort and
 * suppress late results; actual HTTP requests retain their per-request deadlines.
 * A complete replay may include many bounded chunks, so it has no whole-read timer.
 */
function awaitReplay<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(
      new PlatformClientOperationError("ABORTED", "Lifecycle replay was aborted", false),
    ));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    operation.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
