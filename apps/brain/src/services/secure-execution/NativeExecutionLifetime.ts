import type { NativeCommandClosure } from "@repo/shared-types/native-command-closure";

export interface NativeExecutionOperation {
  original: Promise<unknown>;
  readonly transports: Set<Promise<unknown>>;
  dispatched: boolean;
  closure: NativeCommandClosure | null;
}

/** Retains original operations and bodies independently of their timeout or
 * cancellation observers. Authenticated session ports still validate closure. */
export class NativeExecutionLifetime {
  private readonly operations = new Set<NativeExecutionOperation>();
  private dispatchSealed = false;

  registerOperation(): NativeExecutionOperation | null {
    if (this.dispatchSealed) return null;
    const operation: NativeExecutionOperation = {
      original: Promise.resolve(),
      transports: new Set(),
      dispatched: false,
      closure: null,
    };
    this.operations.add(operation);
    return operation;
  }

  retainOriginal<T>(
    operation: NativeExecutionOperation,
    execute: () => Promise<T>,
  ): Promise<T> {
    const original = Promise.resolve().then(execute);
    operation.original = original;
    void original.catch(() => undefined);
    return original;
  }

  /** Called synchronously immediately before the real creator fetch. */
  assertDispatchAllowed(operation: NativeExecutionOperation): void {
    if (this.dispatchSealed)
      throw new Error("Native execution dispatch is closed");
    operation.dispatched = true;
  }

  retainTransport(operation: NativeExecutionOperation, original: Promise<unknown>): void {
    operation.transports.add(original);
    void original.catch(() => undefined);
  }

  recordClosure(
    operation: NativeExecutionOperation,
    closure: NativeCommandClosure | null | undefined,
  ): void {
    if (closure?.state === "settled") operation.closure = closure;
  }

  async awaitQuiescence(timeoutMs: number): Promise<boolean> {
    this.dispatchSealed = true;
    const originals = [...this.operations].map(operation => operation.original);
    try {
      await observeExecutionWithTimeout((async () => {
        await Promise.allSettled(originals);
        // Public operations may have created execute/cancel transports while
        // draining. No new public operation or Secure dispatch can cross the seal.
        await Promise.allSettled([...this.operations].flatMap(operation => [...operation.transports]));
      })(), timeoutMs);
    } catch {
      return false;
    }
    return [...this.operations].every(operation =>
      !operation.dispatched || operation.closure?.state === "settled");
  }
}

export async function observeExecutionWithTimeout<T>(
  original: Promise<T>, timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Execution request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([original, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
