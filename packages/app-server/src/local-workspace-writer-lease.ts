import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { TurnAdmission, WorkspaceId } from "@repo/platform-protocol";
import type { LocalNativeFileIdentity, LocalNativeReleasedFence } from "@repo/event-store";
import { acquireNativeWriterFence } from "@legioncode/execution-engine/runtime/desktop/NativeWriterFence";
import type { SingleProcessMacExecution } from "@legioncode/execution-engine/runtime/desktop/SingleExecutableProcess";
import type { NativeFilesystemExecution } from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import type { LocalMutationLease } from "@legioncode/execution-engine/runtime/desktop/LocalTurnExecutionCapability";
import type {
  LocalTurnAttemptIdentity,
  LocalTurnExecutor,
} from "@legioncode/execution-engine/runtime/desktop/LocalReadOnlyTurnExecutor";
import type { LocalWorkspaceExecutionBinding } from "./local-workspace.js";

export interface LocalWorkspaceWriterAuthority extends LocalMutationLease {
  assertCurrent(): Promise<void>;
  assertSettlementCurrent(): Promise<void>;
  readonly rootDirectory: FileHandle;
  readonly writerLease: FileHandle;
  readonly filesystemRoot: string;
  /** Final capture/publication only; never substitutes for active tool authority. */
  readonly settlementSignal: AbortSignal;
  /** Current identities of this exact held root, namespace and writer file. */
  readPhysicalIdentity(): Promise<LocalWorkspaceWriterReleaseReceipt>;
  trackProcess(execution: SingleProcessMacExecution): void;
  trackFilesystem(execution: NativeFilesystemExecution): void;
  /** Required when construction may have spawned a child without returning its execution. */
  markUnknown(): void;
}

export interface LocalWorkspaceWriterLease extends LocalWorkspaceWriterAuthority {
  /** Metadata-only loan: never exposes FileHandles or execution authority. */
  withPredecessorVerification<T>(operation: (identity: LocalWorkspaceWriterReleaseReceipt) => Promise<T>): Promise<T>;
  withMutationAuthority<T>(
    workspaceId: WorkspaceId,
    operation: (authority: LocalWorkspaceWriterAuthority) => Promise<T>,
  ): Promise<T>;
  withSettlementAuthority<T>(
    operation: (authority: LocalWorkspaceWriterAuthority) => Promise<T>,
  ): Promise<T>;
  /** Supply the factory's combined resource proof, including manifest Git;
   * raw kernel proof alone is insufficient. False retains both original pins.
   */
  release(
    awaitResourceRelease: LocalTurnExecutor["awaitResourceRelease"],
  ): Promise<boolean>;
  /** Caller must fence and await its original publication before this canonical
   * read. Any admission, tracked physical resource or unknown result retains. */
  releaseUnadmitted(readCanonicalAdmission: () => Promise<TurnAdmission | null>): Promise<boolean>;
}

export interface LocalWorkspaceWriterReleaseReceipt {
  readonly root: LocalNativeFileIdentity;
  readonly writerFence: LocalNativeReleasedFence;
}

type Resource = {
  readonly execution: SingleProcessMacExecution | NativeFilesystemExecution;
  readonly closed: Promise<boolean>;
};
type Entry = {
  readonly key: string;
  readonly binding: LocalWorkspaceExecutionBinding;
  readonly attempt: LocalTurnAttemptIdentity;
  readonly rootIdentity: BigIntStats;
  readonly active: AbortController;
  readonly retained: AbortController;
  readonly loans: Set<Promise<unknown>>;
  readonly resources: Set<Resource>;
  physicalExposure: boolean;
  file?: FileHandle;
  fileIdentity?: BigIntStats;
  namespaceIdentity?: BigIntStats;
  unknown: boolean;
  releasing: boolean;
  released: boolean;
  release?: Promise<boolean>;
};

export class LocalWorkspaceWriterLeaseError extends Error {
  /** Positive proof only for resources created by this acquisition, not the
   * borrowed root binding or canonical terminal settlement. */
  readonly awaitAcquisitionQuiescence?: (
    attempt: LocalTurnAttemptIdentity,
  ) => Promise<boolean>;

  constructor(
    readonly code: "workspace_writer_busy" | "workspace_writer_unavailable",
  ) {
    super(
      code === "workspace_writer_busy"
        ? "Workspace writer is busy"
        : "Workspace writer authority is unavailable",
    );
    this.name = "LocalWorkspaceWriterLeaseError";
  }
}

/**
 * One host-owned lease registry. The trusted host creates the private 0700 fence
 * directory beneath its existing storage and NEVER replaces/unlinks that namespace
 * or its lease files. ALL hosts/profiles granting the same physical root must
 * supply the SAME namespace; profile-local directories cannot fence each other.
 * Same-user external namespace modification is not contained.
 * Keep this owner alive for the host lifetime. It consumes an already-owned root
 * binding, never opens another grant/root, and never closes that borrowed binding.
 */
export class LocalWorkspaceWriterLeaseOwner {
  private readonly entries = new Map<string, Entry>();
  private directory?: Promise<{ handle: FileHandle; identity: BigIntStats }>;
  private namespaceLost = false;

  constructor(
    private readonly options: {
      readonly trustedFenceDirectory: string;
      readonly helperPath: string;
    },
  ) {
    if (
      !isAbsolute(options.trustedFenceDirectory) ||
      options.trustedFenceDirectory.includes("\0")
    ) {
      throw new LocalWorkspaceWriterLeaseError("workspace_writer_unavailable");
    }
  }

  /** Release only the exact retained attempt, without a second cleanup registry. */
  async releaseAttempt(
    attempt: LocalTurnAttemptIdentity,
    proof: LocalTurnExecutor["awaitResourceRelease"],
    onReleased?: (receipt: LocalWorkspaceWriterReleaseReceipt) => void,
  ): Promise<boolean> {
    for (const entry of this.entries.values()) {
      if (
        entry.attempt.workspaceId === attempt.workspaceId &&
        entry.attempt.threadId === attempt.threadId &&
        entry.attempt.runId === attempt.runId &&
        entry.attempt.turnId === attempt.turnId &&
        entry.attempt.runAttemptId === attempt.runAttemptId
      ) {
        const released = await this.release(entry, proof);
        if (released && onReleased) onReleased(physicalIdentity(entry));
        return released;
      }
    }
    // Absence is never proof. The factory's combined callback must prove the
    // same terminal attempt and its preparation receipt or released resources.
    try {
      return (await proof(attempt.turnId)) === true;
    } catch {
      return false;
    }
  }

  async acquire(input: {
    readonly binding: LocalWorkspaceExecutionBinding;
    readonly attempt: LocalTurnAttemptIdentity;
  }): Promise<LocalWorkspaceWriterLease> {
    const { binding } = input;
    binding.assertCurrent();
    binding.signal.throwIfAborted();
    if (input.attempt.workspaceId !== binding.workspace.workspaceId) {
      throw new LocalWorkspaceWriterLeaseError("workspace_writer_unavailable");
    }
    const identity = await binding.rootDirectory.stat({ bigint: true });
    binding.assertCurrent();
    if (!identity.isDirectory() || this.namespaceLost) {
      throw new LocalWorkspaceWriterLeaseError("workspace_writer_unavailable");
    }
    const key = `${identity.dev.toString(16)}-${identity.ino.toString(16)}`;
    if (this.entries.has(key)) throw knownBusyAcquisition(input.attempt);
    const entry: Entry = {
      key,
      binding,
      attempt: Object.freeze({ ...input.attempt }),
      rootIdentity: identity,
      active: new AbortController(),
      retained: new AbortController(),
      loans: new Set(),
      resources: new Set(),
      physicalExposure: false,
      unknown: false,
      releasing: false,
      released: false,
    };
    this.entries.set(key, entry);
    let attempted = false;
    let busy = false;
    try {
      await this.assertDirectory();
      entry.namespaceIdentity = (await this.directory!).identity;
      binding.assertCurrent();
      entry.file = await open(
        this.filePath(entry),
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      entry.fileIdentity = await entry.file.stat({ bigint: true });
      await this.assertEntry(entry, false);
      attempted = true;
      const acquired = await acquireNativeWriterFence({
        helperPath: this.options.helperPath,
        leaseFile: entry.file,
        signal: AbortSignal.any([binding.signal, entry.active.signal]),
      });
      if (acquired === "busy") {
        attempted = false;
        busy = true;
        throw new LocalWorkspaceWriterLeaseError("workspace_writer_busy");
      }
      await this.assertEntry(entry, false);
      return this.authority(entry);
    } catch (error) {
      if (attempted) {
        // Missing receipt can follow successful acquisition. Keep the actual
        // FileHandle AND original binding, not merely a cached descriptor number.
        this.markUnknown(entry);
      } else {
        let closed = false;
        try {
          await entry.file?.close();
          this.entries.delete(key);
          closed = true;
        } catch {
          this.markUnknown(entry);
        }
        if (busy && closed) throw knownBusyAcquisition(entry.attempt);
      }
      throw error instanceof LocalWorkspaceWriterLeaseError
        ? error
        : new LocalWorkspaceWriterLeaseError("workspace_writer_unavailable");
    }
  }

  private authority(entry: Entry): LocalWorkspaceWriterLease {
    const writerLease = entry.file!;
    const markUnknown = () => this.markUnknown(entry);
    const track = (
      execution: Resource["execution"],
      proof: Promise<unknown>,
    ) => {
      entry.physicalExposure = true;
      const closed = proof
        .then(
          () => execution.quiescent === true,
          () => false,
        )
        .then((known) => {
          if (!known) markUnknown();
          return known;
        });
      entry.resources.add({ execution, closed });
      if (entry.releasing || entry.released) {
        markUnknown();
        throw new LocalWorkspaceWriterLeaseError(
          "workspace_writer_unavailable",
        );
      }
    };
    const authority: LocalWorkspaceWriterAuthority = Object.freeze({
      attempt: entry.attempt,
      rootDirectory: entry.binding.rootDirectory,
      writerLease,
      filesystemRoot: entry.binding.filesystemRoot,
      signal: AbortSignal.any([entry.binding.signal, entry.active.signal]),
      settlementSignal: entry.retained.signal,
      readPhysicalIdentity: async () => {
        await this.assertEntry(entry, false);
        return physicalIdentity(entry);
      },
      assertCurrent: () => this.assertEntry(entry, false),
      assertSettlementCurrent: () => this.assertEntry(entry, true),
      trackProcess: (execution: SingleProcessMacExecution) =>
        track(execution, execution.result),
      trackFilesystem: (execution: NativeFilesystemExecution) =>
        track(execution, execution.closed),
      markUnknown,
    });
    const borrow = <T>(
      settlement: boolean,
      operation: (value: LocalWorkspaceWriterAuthority) => Promise<T>,
    ): Promise<T> => {
      // Sticky: even a completed loan may have authorized physical execution.
      entry.physicalExposure = true;
      const loan = (async () => {
        if (entry.releasing)
          throw new LocalWorkspaceWriterLeaseError(
            "workspace_writer_unavailable",
          );
        await this.assertEntry(entry, settlement);
        return await operation(authority);
      })();
      entry.loans.add(loan);
      return loan.finally(() => {
        entry.loans.delete(loan);
      });
    };
    return Object.freeze({
      ...authority,
      withPredecessorVerification: <T>(operation: (identity: LocalWorkspaceWriterReleaseReceipt) => Promise<T>) => {
        const loan = Promise.resolve().then(async () => {
          if (entry.releasing || entry.released) throw new LocalWorkspaceWriterLeaseError("workspace_writer_unavailable");
          await this.assertEntry(entry, false);
          const result = await operation(physicalIdentity(entry));
          await this.assertEntry(entry, false);
          return result;
        });
        entry.loans.add(loan);
        return loan.finally(() => { entry.loans.delete(loan); });
      },
      withMutationAuthority: <T>(
        workspaceId: WorkspaceId,
        operation: (value: LocalWorkspaceWriterAuthority) => Promise<T>,
      ) => {
        if (workspaceId !== entry.attempt.workspaceId)
          throw new LocalWorkspaceWriterLeaseError(
            "workspace_writer_unavailable",
          );
        return borrow(false, operation);
      },
      withSettlementAuthority: <T>(
        operation: (value: LocalWorkspaceWriterAuthority) => Promise<T>,
      ) => borrow(true, operation),
      release: (proof: LocalTurnExecutor["awaitResourceRelease"]) =>
        this.release(entry, proof),
      releaseUnadmitted: (readCanonicalAdmission: () => Promise<TurnAdmission | null>) => {
        entry.release ??= this.releaseUnadmitted(entry, readCanonicalAdmission);
        return entry.release;
      },
    });
  }

  private release(
    entry: Entry,
    proof: LocalTurnExecutor["awaitResourceRelease"],
  ): Promise<boolean> {
    entry.release ??= this.releaseAfterProof(entry, proof);
    return entry.release;
  }

  private async releaseAfterProof(
    entry: Entry,
    proof: LocalTurnExecutor["awaitResourceRelease"],
  ): Promise<boolean> {
    try {
      if (entry.released) return true;
      if (
        entry.unknown ||
        entry.releasing ||
        this.entries.get(entry.key) !== entry
      )
        return false;
      if (!(await proof(entry.attempt.turnId))) {
        this.markUnknown(entry);
        return false;
      }
      entry.releasing = true;
      entry.active.abort("Writer settlement is releasing");
      await Promise.allSettled([...entry.loans]);
      if (
        !(
          await Promise.all(
            [...entry.resources].map((resource) => resource.closed),
          )
        ).every(Boolean) ||
        entry.unknown ||
        !(await proof(entry.attempt.turnId))
      ) {
        this.markUnknown(entry);
        return false;
      }
      await this.assertEntry(entry, true);
      await entry.file!.close();
      entry.released = true;
      entry.retained.abort("Writer settlement released");
      this.entries.delete(entry.key);
      return true;
    } catch {
      this.markUnknown(entry);
      return false;
    }
  }

  private async releaseUnadmitted(entry: Entry, readCanonicalAdmission: () => Promise<TurnAdmission | null>): Promise<boolean> {
    try {
      if (entry.unknown || entry.releasing || entry.released || this.entries.get(entry.key) !== entry) return false;
      entry.releasing = true;
      entry.active.abort("Unused writer acquisition is closing");
      await Promise.allSettled([...entry.loans]);
      if (entry.unknown || entry.physicalExposure || entry.loans.size || entry.resources.size || await readCanonicalAdmission() !== null) {
        this.markUnknown(entry);
        return false;
      }
      await this.assertEntry(entry, true);
      await entry.file!.close();
      entry.released = true;
      entry.retained.abort("Unused writer acquisition released");
      this.entries.delete(entry.key);
      return true;
    } catch {
      this.markUnknown(entry);
      return false;
    }
  }

  private async assertEntry(entry: Entry, settlement: boolean): Promise<void> {
    if (
      entry.unknown ||
      this.namespaceLost ||
      this.entries.get(entry.key) !== entry ||
      !entry.file ||
      !entry.fileIdentity
    ) {
      throw new LocalWorkspaceWriterLeaseError("workspace_writer_unavailable");
    }
    const check = () => {
      if (settlement) {
        entry.retained.signal.throwIfAborted();
        entry.binding.assertSettlementCurrent();
      } else {
        entry.active.signal.throwIfAborted();
        entry.binding.signal.throwIfAborted();
        entry.binding.assertCurrent();
      }
    };
    check();
    await this.assertDirectory();
    const [root, file, named] = await Promise.all([
      entry.binding.rootDirectory.stat({ bigint: true }),
      entry.file.stat({ bigint: true }),
      lstat(this.filePath(entry), { bigint: true }),
    ]);
    if (
      !root.isDirectory() ||
      !sameIdentity(root, entry.rootIdentity) ||
      !privateFile(file) ||
      !privateFile(named) ||
      !sameIdentity(file, entry.fileIdentity) ||
      !sameIdentity(named, file)
    ) {
      this.markUnknown(entry);
      throw new LocalWorkspaceWriterLeaseError("workspace_writer_unavailable");
    }
    check();
  }

  private filePath(entry: Entry): string {
    return join(this.options.trustedFenceDirectory, `${entry.key}.lease`);
  }

  private markUnknown(entry: Entry): void {
    entry.unknown = true;
    entry.active.abort("Writer authority is quarantined");
    entry.retained.abort("Writer settlement authority is quarantined");
  }

  private async assertDirectory(): Promise<void> {
    try {
      if (this.namespaceLost) throw new Error("Fence namespace changed");
      this.directory ??= this.pinDirectory();
      const pin = await this.directory;
      const [held, named, canonical] = await Promise.all([
        pin.handle.stat({ bigint: true }),
        lstat(this.options.trustedFenceDirectory, { bigint: true }),
        realpath(this.options.trustedFenceDirectory),
      ]);
      if (
        !privateDirectory(held) ||
        !privateDirectory(named) ||
        canonical !== this.options.trustedFenceDirectory ||
        !sameIdentity(held, pin.identity) ||
        !sameIdentity(named, held)
      )
        throw new Error("Fence namespace changed");
    } catch {
      this.namespaceLost = true;
      for (const entry of this.entries.values()) this.markUnknown(entry);
      throw new LocalWorkspaceWriterLeaseError("workspace_writer_unavailable");
    }
  }

  private async pinDirectory(): Promise<{
    handle: FileHandle;
    identity: BigIntStats;
  }> {
    const path = this.options.trustedFenceDirectory;
    const named = await lstat(path, { bigint: true });
    if (!privateDirectory(named) || (await realpath(path)) !== path)
      throw new Error("Invalid fence namespace");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const identity = await handle.stat({ bigint: true });
      if (!privateDirectory(identity) || !sameIdentity(identity, named))
        throw new Error("Fence namespace changed");
      return { handle, identity };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}

function knownBusyAcquisition(
  attempt: LocalTurnAttemptIdentity,
): LocalWorkspaceWriterLeaseError {
  const captured = Object.freeze({ ...attempt });
  const error = new LocalWorkspaceWriterLeaseError("workspace_writer_busy");
  Object.defineProperty(error, "awaitAcquisitionQuiescence", {
    value: async (candidate: LocalTurnAttemptIdentity): Promise<boolean> =>
      candidate.workspaceId === captured.workspaceId &&
      candidate.threadId === captured.threadId &&
      candidate.runId === captured.runId &&
      candidate.turnId === captured.turnId &&
      candidate.runAttemptId === captured.runAttemptId,
  });
  return error;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function physicalIdentity(entry: Entry): LocalWorkspaceWriterReleaseReceipt {
  if (!entry.fileIdentity || !entry.namespaceIdentity) throw new Error("Writer physical identity is unavailable");
  const identity = (value: BigIntStats): LocalNativeFileIdentity => Object.freeze({
    device: value.dev.toString(16), inode: value.ino.toString(16),
  });
  return Object.freeze({
    root: identity(entry.rootIdentity),
    writerFence: Object.freeze({ namespace: identity(entry.namespaceIdentity), lease: identity(entry.fileIdentity) }),
  });
}
function privateDirectory(value: BigIntStats): boolean {
  return (
    value.isDirectory() &&
    !value.isSymbolicLink() &&
    value.uid === BigInt(process.geteuid!()) &&
    (value.mode & 0o777n) === 0o700n
  );
}
function privateFile(value: BigIntStats): boolean {
  return (
    value.isFile() &&
    !value.isSymbolicLink() &&
    value.nlink === 1n &&
    value.uid === BigInt(process.geteuid!()) &&
    (value.mode & 0o777n) === 0o600n
  );
}
