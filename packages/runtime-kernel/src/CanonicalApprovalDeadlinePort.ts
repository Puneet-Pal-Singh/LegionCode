import { RuntimeKernelError } from "./errors.js";
import type { ApprovalWaitPort } from "./ports.js";
import type { ApprovalResolution } from "./types.js";

/** Expiry contender only. ApprovalCoordinator owns decisions and canonical events. */
export class CanonicalApprovalDeadlinePort implements ApprovalWaitPort {
  constructor(private readonly timeoutMs: number = 300_000) {}

  waitForDecision(
    input: Parameters<ApprovalWaitPort["waitForDecision"]>[0],
  ): Promise<ApprovalResolution> {
    const signal = input.signal;
    if (signal?.aborted) return Promise.reject(cancelled());
    const timeoutMs = this.timeoutMs;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(cancelled());
      };
      const expire = () => {
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining > 0) {
          // Preserve long configured deadlines without overflowing the host timer.
          timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
          return;
        }
        cleanup();
        resolve({
          decision: "denied",
          decidedBy: null,
          reason: "Approval timed out before a decision was recorded.",
          timedOut: true,
        });
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else timer = setTimeout(expire, Math.min(timeoutMs, 2_147_483_647));
    });
  }
}

function cancelled(): RuntimeKernelError {
  return new RuntimeKernelError("turn_cancelled", "Approval wait cancelled.");
}
