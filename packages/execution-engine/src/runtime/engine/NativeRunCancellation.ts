import { RuntimeKernelError } from "@repo/runtime-kernel";

const NATIVE_CANCELLATION_POLL_INTERVAL_MS = 2_000;

export class NativeRunCancelledError extends RuntimeKernelError {
  constructor() {
    super("turn_cancelled", "Run was cancelled");
    this.name = "NativeRunCancelledError";
  }
}

export async function assertNativeRunNotCancelled(
  isRunCancelled: () => Promise<boolean>,
): Promise<void> {
  if (await isRunCancelled()) {
    throw new NativeRunCancelledError();
  }
}

export function assertSignalNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new NativeRunCancelledError();
  }
}

export async function runWithNativeCancellationPolling<T>(
  operation: Promise<T>,
  isRunCancelled: () => Promise<boolean>,
): Promise<T> {
  let stopPolling = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const cancellation = new Promise<never>((_, reject) => {
    const schedulePoll = (): void => {
      timeout = setTimeout(() => {
        void pollCancellation().catch(reject);
      }, NATIVE_CANCELLATION_POLL_INTERVAL_MS);
    };

    const pollCancellation = async (): Promise<void> => {
      if (stopPolling) {
        return;
      }
      await assertNativeRunNotCancelled(isRunCancelled);
      if (!stopPolling) {
        schedulePoll();
      }
    };

    schedulePoll();
  });

  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    stopPolling = true;
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
