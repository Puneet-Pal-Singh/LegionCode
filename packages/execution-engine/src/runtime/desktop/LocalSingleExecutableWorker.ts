import { fstatSync, lstatSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  RunSchema,
  TurnSchema,
  RunAttemptIdSchema,
  ToolCallItemContentSchema,
} from "@repo/platform-protocol";
import type {
  RuntimeKernelDependencies,
  StartTurnInput,
  WorkerProtocolPort,
  WorkerToolResult,
} from "@repo/runtime-kernel";
import { RUN_EXECUTABLE_TOOL_INPUT_SCHEMA } from "../tools/RunExecutableTool.js";
import { assertLocalToolApproved } from "./LocalToolApproval.js";
import type { LocalTurnAttemptIdentity } from "./LocalReadOnlyTurnExecutor.js";
import {
  executeSingleProcessMac,
  type SingleProcessMacExecution,
} from "./SingleExecutableProcess.js";
import type { LocalProcessOutput } from "./NativeProcessOutput.js";

type ExecutionInput = Parameters<WorkerProtocolPort["executeTool"]>[0];

/** Borrowed from the canonical host lease owner; this worker never opens or closes either pin. */
export interface LocalSingleExecutableAuthority {
  readonly attempt: LocalTurnAttemptIdentity;
  readonly rootDirectory: FileHandle;
  readonly writerLease: FileHandle;
  readonly filesystemRoot: string;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  trackProcess(execution: SingleProcessMacExecution): void;
  markUnknown(): void;
}

export interface LocalSingleExecutableLease {
  withMutationAuthority<T>(
    workspaceId: LocalTurnAttemptIdentity["workspaceId"],
    operation: (authority: LocalSingleExecutableAuthority) => Promise<T>,
  ): Promise<T>;
}

/** Approval-bound adapter to the shared OS runner; runtime alone emits lifecycle. */
export class LocalSingleExecutableWorker implements WorkerProtocolPort {
  private readonly admission: Pick<
    StartTurnInput,
    "run" | "turn" | "runAttemptId"
  >;
  private readonly identity: LocalTurnAttemptIdentity;
  private readonly stopped = new AbortController();
  private readonly pending = new Set<Promise<WorkerToolResult>>();
  private readonly processes = new Map<
    SingleProcessMacExecution,
    LocalSingleExecutableAuthority
  >();
  private tail: Promise<unknown> = Promise.resolve();
  private closureUnknown = false;

  constructor(
    private readonly options: {
      readonly admission: Pick<StartTurnInput, "run" | "turn" | "runAttemptId">;
      readonly lease: LocalSingleExecutableLease;
      readonly processHelperPath: string;
      readonly lifecycleEvents: Pick<
        RuntimeKernelDependencies["lifecycleEvents"],
        "replay"
      >;
      /** Requires the same lease and a real full-capture baseline for this attempt. */
      readonly assertMutationReady: (
        identity: LocalTurnAttemptIdentity,
      ) => Promise<void>;
    },
  ) {
    this.admission = {
      run: RunSchema.parse(options.admission.run),
      turn: TurnSchema.parse(options.admission.turn),
      runAttemptId: RunAttemptIdSchema.parse(options.admission.runAttemptId),
    };
    const { run, turn, runAttemptId } = this.admission;
    if (
      turn.runId !== run.id ||
      turn.threadId !== run.threadId ||
      !isAbsolute(options.processHelperPath) ||
      options.processHelperPath.includes("\0")
    ) {
      throw new Error(
        "Executable worker requires canonical admission and trusted helper path",
      );
    }
    this.identity = Object.freeze({
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      runId: run.id,
      turnId: turn.id,
      runAttemptId,
    });
  }

  executeTool(input: ExecutionInput): Promise<WorkerToolResult> {
    let captured: ExecutionInput;
    try {
      captured = {
        ...input,
        workspace: { ...input.workspace },
        toolCall: ToolCallItemContentSchema.parse(input.toolCall),
        approval: input.approval ? { ...input.approval } : null,
      };
    } catch (error) {
      return Promise.resolve(failure(error));
    }
    const operation = this.tail
      .then(() => this.execute(captured))
      .catch((error: unknown) => {
        if (this.closureUnknown) return failure(error, true);
        if (this.stopped.signal.aborted || captured.signal?.aborted)
          return {
            kind: "cancelled" as const,
            reason: "Local executable interrupted before launch",
          };
        return failure(error);
      });
    this.tail = operation;
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation));
    return operation;
  }

  /** Physical cancellation only; the kernel owns the Stop command and terminal event. */
  stop(
    turnId: LocalTurnAttemptIdentity["turnId"],
    reason = "Local executable interrupted",
  ): void {
    if (turnId !== this.identity.turnId) return;
    if (!this.stopped.signal.aborted) this.stopped.abort(reason);
    for (const [execution, authority] of this.processes) {
      try {
        execution.stop();
      } catch {
        this.markUnknown(authority);
      }
    }
  }

  async awaitQuiescence(input: {
    readonly turnId: LocalTurnAttemptIdentity["turnId"];
    readonly timeoutMs: number;
  }): Promise<boolean> {
    if (
      input.turnId !== this.identity.turnId ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs < 0 ||
      this.closureUnknown
    )
      return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([...this.pending]).then(
          () =>
            !this.closureUnknown &&
            this.pending.size === 0 &&
            [...this.processes.keys()].every(
              (execution) => execution.quiescent,
            ),
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), input.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async execute(input: ExecutionInput): Promise<WorkerToolResult> {
    if (this.closureUnknown)
      throw new Error("Executable physical closure requires reconciliation");
    this.stopped.signal.throwIfAborted();
    if (input.toolCall.toolName !== "run_executable")
      throw new Error("Tool is outside the single-executable capability");
    const parsed = RUN_EXECUTABLE_TOOL_INPUT_SCHEMA.parse(input.toolCall.input);
    await assertLocalToolApproved({
      admission: this.admission,
      lifecycleEvents: this.options.lifecycleEvents,
      input,
      schema: RUN_EXECUTABLE_TOOL_INPUT_SCHEMA,
    });
    return this.options.lease.withMutationAuthority(
      this.identity.workspaceId,
      async (authority) => {
        for (const key of Object.keys(this.identity) as Array<
          keyof LocalTurnAttemptIdentity
        >) {
          if (authority.attempt[key] !== this.identity[key])
            throw new Error(
              "Writer lease belongs to a different exact attempt",
            );
        }
        if (authority.filesystemRoot !== input.workspace.filesystemRoot)
          throw new Error(
            "Executable root does not match the admitted workspace",
          );
        const signal = AbortSignal.any([
          this.stopped.signal,
          authority.signal,
          ...(input.signal ? [input.signal] : []),
        ]);
        const abort = () =>
          this.stop(this.identity.turnId, "Local executable interrupted");
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          await authority.assertCurrent();
          await this.options.assertMutationReady(this.identity);
          const rootDirectory = authority.rootDirectory;
          const writerLease = authority.writerLease;
          const rootFd = rootDirectory.fd;
          const leaseFd = writerLease.fd;
          const [root, lease] = await Promise.all([
            rootDirectory.stat({ bigint: true }),
            writerLease.stat({ bigint: true }),
          ]);
          await authority.assertCurrent();
          signal.throwIfAborted();
          // The host proves canonical lease ownership. These synchronous checks
          // keep its same FileHandles and descriptor identities through spawn.
          const currentRoot = fstatSync(rootFd, { bigint: true });
          const currentLease = fstatSync(leaseFd, { bigint: true });
          const pathRoot = lstatSync(authority.filesystemRoot, {
            bigint: true,
          });
          if (
            authority.rootDirectory !== rootDirectory ||
            authority.writerLease !== writerLease ||
            rootDirectory.fd !== rootFd ||
            writerLease.fd !== leaseFd ||
            !currentRoot.isDirectory() ||
            !currentLease.isFile() ||
            !pathRoot.isDirectory() ||
            pathRoot.isSymbolicLink() ||
            root.dev !== currentRoot.dev ||
            root.ino !== currentRoot.ino ||
            lease.dev !== currentLease.dev ||
            lease.ino !== currentLease.ino ||
            pathRoot.dev !== currentRoot.dev ||
            pathRoot.ino !== currentRoot.ino
          ) {
            throw new Error(
              "Held executable root or writer lease changed before launch",
            );
          }
          let execution: SingleProcessMacExecution;
          try {
            execution = executeSingleProcessMac({
              executable: parsed.executable,
              args: parsed.args,
              cwd: parsed.cwd ?? ".",
              cwdFd: rootFd,
              writerLease,
              signal,
              processHelperPath: this.options.processHelperPath,
              sandbox: {
                scope: "single_executable_nofork",
                filesystemRoot: authority.filesystemRoot,
              },
              timeoutMs: 60_000,
            });
            // Keep the returned handle even if registration throws after spawn.
            this.processes.set(execution, authority);
            authority.trackProcess(execution);
          } catch (error) {
            this.markUnknown(authority);
            this.stop(this.identity.turnId);
            for (const process of this.processes.keys())
              void process.result.catch(() => undefined);
            throw error;
          }
          try {
            const result = await execution.result;
            if (!execution.quiescent || result.outputClosed) {
              this.markUnknown(authority);
              execution.stop();
              return failure(
                new Error("Executable physical closure was not proved"),
                true,
              );
            }
            if (signal.aborted)
              return {
                kind: "cancelled",
                reason:
                  "Local executable interrupted after verified process closure",
              };
            const output = presentOutput(result);
            if (
              result.timedOut ||
              result.exitCode !== 0 ||
              result.signal !== null
            ) {
              return {
                kind: "failed",
                disposition: "recoverable",
                failure: {
                  code: result.timedOut
                    ? "command_timed_out"
                    : "command_failed",
                  message: result.timedOut
                    ? "Executable exceeded its bounded deadline"
                    : `Executable exited with code ${result.exitCode} and signal ${result.signal}`,
                  retryable: false,
                  correlationId: null,
                  details: output,
                },
              };
            }
            return { kind: "completed", output };
          } catch (error) {
            if (!execution.quiescent) {
              this.markUnknown(authority);
              execution.stop();
              return failure(error, true);
            }
            if (signal.aborted)
              return {
                kind: "cancelled",
                reason:
                  "Local executable interrupted after verified process closure",
              };
            return failure(error);
          } finally {
            if (execution.quiescent) this.processes.delete(execution);
          }
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
    );
  }

  private markUnknown(authority: LocalSingleExecutableAuthority): void {
    this.closureUnknown = true;
    authority.markUnknown();
  }
}

function presentOutput(result: LocalProcessOutput) {
  const bytes = Buffer.from(
    result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ""),
  );
  const maximum = 128 * 1024;
  return {
    // Streaming decode omits an incomplete final scalar instead of growing the byte limit.
    content: new TextDecoder().decode(bytes.subarray(0, maximum), {
      stream: true,
    }),
    metadata: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated || bytes.length > maximum,
    },
  };
}

function failure(error: unknown, uncertain = false): WorkerToolResult {
  return {
    kind: "failed",
    disposition: uncertain ? "terminal" : "recoverable",
    failure: {
      code: uncertain ? "internal_error" : "policy_denied",
      message: (error instanceof Error && error.message
        ? error.message
        : "Local executable failed"
      ).slice(0, 10_000),
      retryable: false,
      correlationId: null,
      details: null,
    },
  };
}
