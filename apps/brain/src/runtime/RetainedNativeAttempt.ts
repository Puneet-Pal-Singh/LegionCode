import type { TurnAdmissionRecord } from "@repo/persistence";

/** Private ownership receipt; never a second lifecycle or renderer state. */
export interface ClaimedNativeAttempt {
  readonly admission: Readonly<TurnAdmissionRecord>;
  readonly correlationId: string;
}

export interface NativeAttemptObserver {
  claimed(attempt: ClaimedNativeAttempt): void;
  /** Called only by the original attempt after its physical resource owners settle. */
  cleanupSettled(): void;
}

/** Issued by the preparation owner at a known capability boundary, never from an error code. */
export interface NativePreparationCleanupReceipt {
  readonly kind: "no_exposure";
}

/** Retains the original operation before allowing its admission ACK to escape.
 * waitUntil is bounded host retention, not restart-safe execution. Durable
 * admission/replay retains recovery identity; an ambiguous attempt is never rerun.
 */
export function retainNativeAttempt(input: {
  readonly owner: { waitUntil(operation: Promise<unknown>): void };
  readonly execute: (observer: NativeAttemptObserver) => Promise<Response>;
  readonly accepted: (attempt: ClaimedNativeAttempt) => Response;
  readonly settled: (attempt: ClaimedNativeAttempt) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}): Promise<Response> {
  let resolveResponse!: (response: Response) => void;
  let rejectResponse!: (error: unknown) => void;
  const response = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  let start!: () => void;
  const gate = new Promise<void>(resolve => { start = resolve; });
  let claim: ClaimedNativeAttempt | undefined;
  let cleanupSettled = false;
  const original = gate.then(() => input.execute({
    claimed(attempt) {
      if (claim) throw new Error("Native attempt was claimed twice");
      claim = attempt;
      try {
        resolveResponse(input.accepted(attempt));
      } catch (error) {
        // The executor may catch callback failures for canonical recovery.
        rejectResponse(error);
        throw error;
      }
    },
    cleanupSettled() {
      if (!claim) throw new Error("Unclaimed Native attempt cannot settle resources");
      cleanupSettled = true;
    },
  })).then(async result => {
    if (!claim) {
      // Validation and claim conflicts retain their original HTTP response.
      resolveResponse(result);
      return;
    }
    // The original response producer belongs to the retained DO operation too.
    await result.arrayBuffer();
    if (cleanupSettled) await input.settled(claim);
  }).catch((error: unknown) => {
    rejectResponse(error); // Harmless once an admission ACK has already resolved.
    try {
      input.reportError(error);
    } catch {
      console.error("[run/runtime] Retained attempt error reporting failed");
    }
  });
  // Do not start anything if the host cannot retain the original operation.
  input.owner.waitUntil(original);
  start();
  return response;
}
