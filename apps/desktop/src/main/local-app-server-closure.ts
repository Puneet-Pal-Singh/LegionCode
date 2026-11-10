import type { UtilityProcess } from "electron";
import type { LocalAppServerShutdownMessage } from "../shared/desktop-api";

const CLOSURE_RECEIPT_TIMEOUT_MS = 5_000;

/** Retains one actual child until its private physical/SQLite closure receipt. */
export class LocalAppServerClosure {
  private confirmed = false;
  private failure: Error | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private resolveClosed: (() => void) | null = null;
  private rejectClosed: ((error: Error) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly child: UtilityProcess) {}

  requestShutdown(): Promise<void> {
    if (this.confirmed) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    if (this.shutdownPromise) return this.shutdownPromise;
    const pending = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    this.shutdownPromise = pending;
    this.timer = setTimeout(() => {
      this.markUnknown("Local runtime closure could not be confirmed before the wait expired");
    }, CLOSURE_RECEIPT_TIMEOUT_MS);
    try {
      this.child.postMessage({ type: "shutdown" } satisfies LocalAppServerShutdownMessage);
    } catch {
      this.markUnknown("The local runtime shutdown request could not be delivered");
    }
    return pending;
  }

  acknowledgeClosed(): void {
    this.confirmed = true;
    this.failure = null;
    this.clearTimer();
    this.resolveClosed?.();
    this.resolveClosed = null;
    this.rejectClosed = null;
  }

  markUnknown(reason: string): void {
    if (this.confirmed) return;
    this.failure ??= new Error(reason);
    this.clearTimer();
    this.rejectClosed?.(this.failure);
    this.resolveClosed = null;
    this.rejectClosed = null;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
