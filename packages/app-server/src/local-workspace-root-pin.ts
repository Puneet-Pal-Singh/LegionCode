import type { NativeFilesystemExecution } from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import { lstat, realpath, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { MacGitAuthority } from "./local-mac-git-execution.js";

/** One grant-owner descriptor loan. Rejection is not proof of process closure. */
export class LocalWorkspaceRootPin {
  private state: "open" | "closing" | "closed" | "quarantined" = "open";
  private readonly loans = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;

  constructor(
    readonly path: string,
    readonly rootDirectory: FileHandle,
    readonly signal: AbortSignal,
    private readonly identity: BigIntStats,
    private readonly assertOwner: () => void,
    private readonly retainQuarantined: (pin: LocalWorkspaceRootPin) => void,
  ) {}

  get quarantined(): boolean { return this.state === "quarantined"; }

  assertCurrent(): void {
    this.assertOwner();
    this.signal.throwIfAborted();
    if (this.state !== "open" || this.rootDirectory.fd < 0) {
      throw new Error("Workspace root pin is not available");
    }
  }

  /** Same admitted root only; does not restore authority for new tools or prove a writer fence. */
  assertSettlementCurrent(): void {
    if (this.state !== "open" || this.rootDirectory.fd < 0) {
      throw new Error("Retained workspace settlement descriptor is unavailable");
    }
  }

  async assertPathCurrent(): Promise<void> {
    this.assertCurrent();
    const pathIdentity = await lstat(this.path, { bigint: true });
    const heldIdentity = await this.rootDirectory.stat({ bigint: true });
    const canonicalPath = await realpath(this.path);
    this.assertCurrent();
    if (!pathIdentity.isDirectory() || pathIdentity.isSymbolicLink() ||
        pathIdentity.dev !== this.identity.dev || pathIdentity.ino !== this.identity.ino ||
        heldIdentity.dev !== this.identity.dev || heldIdentity.ino !== this.identity.ino ||
        canonicalPath !== this.path) {
      throw new Error("Workspace root changed during the operation");
    }
  }

  /** Retain the descriptor until the real native helper and pipes close. */
  readonly observeNativeExecution = (
    execution: NativeFilesystemExecution,
  ): void => {
    this.assertCurrent();
    const loan = execution.closed
      .then(() => {
        if (!execution.quiescent)
          throw new Error("Native metadata helper did not prove closure");
      })
      .catch((error: unknown) => {
        this.state = "quarantined";
        this.retainQuarantined(this);
        throw error;
      });
    this.loans.add(loan);
    void loan.finally(() => this.loans.delete(loan)).catch(() => undefined);
  };

  readonly withRootAuthority = async <T>(
    cwd: string,
    operation: (authority: MacGitAuthority) => Promise<T>,
    turnSignal?: AbortSignal,
  ): Promise<T> => {
    this.assertCurrent();
    if (cwd !== this.path) throw new Error("Repository probe requested a different root");
    const signal = turnSignal ? AbortSignal.any([this.signal, turnSignal]) : this.signal;
    signal.throwIfAborted();
    const loan = this.borrow(operation, signal);
    this.loans.add(loan);
    try { return await loan; } finally { this.loans.delete(loan); }
  };

  private async borrow<T>(operation: (authority: MacGitAuthority) => Promise<T>, signal: AbortSignal): Promise<T> {
    let result: T;
    try {
      result = await operation({
        cwdFd: this.rootDirectory.fd,
        signal,
        sandbox: { scope: "single_executable_nofork", filesystemRoot: this.path },
      });
      if (typeof result !== "object" || result === null ||
          !("quiescent" in result) || result.quiescent !== true ||
          !("outputClosed" in result) || result.outputClosed !== false) {
        throw new Error("Repository probe did not prove physical closure");
      }
    } catch (error) {
      this.state = "quarantined";
      this.retainQuarantined(this);
      throw error;
    }
    // Revoke after a positive closure receipt invalidates the result, not the pin's closure proof.
    this.assertOwner();
    signal.throwIfAborted();
    return result;
  }

  close(): Promise<void> {
    this.closing ??= this.closeAfterLoans();
    return this.closing;
  }

  private async closeAfterLoans(): Promise<void> {
    if (this.quarantined) throw new Error("Workspace root pin is quarantined until host restart");
    this.state = "closing";
    await Promise.allSettled([...this.loans]);
    if (this.quarantined) throw new Error("Workspace root pin is quarantined until host restart");
    try {
      await this.rootDirectory.close();
      this.state = "closed";
    } catch (error) {
      this.state = "quarantined";
      this.retainQuarantined(this);
      throw error;
    }
  }
}
