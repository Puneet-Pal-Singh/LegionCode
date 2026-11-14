import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { GitServiceError } from "@repo/git-service/errors";
import type { GitCommandExecutionResult } from "@repo/git-service/executor";
import {
  NativeFilesystemBridge,
  parseNativeGitMetadataIdentity,
  type NativeGitMetadataIdentity,
  type NativeGitMetadataLayout,
} from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import {
  executeSingleProcessMac,
  type SingleProcessMacExecution,
} from "@legioncode/execution-engine/runtime/desktop/SingleExecutableProcess";
import type { LocalWorkspaceWriterAuthority } from "./local-workspace-writer-lease.js";
import type { LocalWorkspaceExecutionBinding } from "./local-workspace.js";
import { trustedLocalGitContext } from "./local-git-context.js";

export interface LocalNativeGitOptions {
  readonly gitExecutable: string;
  readonly processHelperPath: string;
  readonly filesystemHelperPath: string;
  /** Captured by the trusted grant owner before its original Git probe. */
  readonly metadataIdentity: NativeGitMetadataIdentity;
  readonly inspectMetadataLayout: LocalWorkspaceExecutionBinding["inspectMetadataLayout"];
}

const unavailable = (message: string) =>
  new GitServiceError("git_process_containment_unavailable", message);

/** One OS binding shared by canonical capture and commit policies. */
export function createNativeGitBinding(
  options: LocalNativeGitOptions,
  mode: "capture" | "read_only" = "capture",
) {
  const readOnly = mode === "read_only";
  if (process.platform !== "darwin")
    throw unavailable("Native Git requires Darwin");
  for (const path of [
    options.gitExecutable,
    options.processHelperPath,
    options.filesystemHelperPath,
  ]) {
    if (!isAbsolute(path) || path.includes("\0") || realpathSync(path) !== path)
      throw unavailable(
        "Native Git requires trusted canonical executable paths",
      );
  }
  const metadataIdentity = parseNativeGitMetadataIdentity(
    options.metadataIdentity,
  );
  const inspectMetadataLayout = options.inspectMetadataLayout;
  if (typeof inspectMetadataLayout !== "function")
    throw unavailable(
      "Native Git requires the original grant metadata resolver",
    );
  const trustedGitContext = trustedLocalGitContext();
  return (authority: LocalWorkspaceWriterAuthority) => {
    const filesystem = new NativeFilesystemBridge({
      helperPath: options.filesystemHelperPath,
      rootDirectory: authority.rootDirectory,
      writerLease: authority.writerLease,
      observeExecution: authority.trackFilesystem,
    });
    let unknown = false;
    const markUnknown = () => {
      unknown = true;
      authority.markUnknown();
    };
    const verifyMetadata = async (
      purpose: "association" | "mutation" = "association",
    ): Promise<NativeGitMetadataLayout> => {
      await authority.assertSettlementCurrent();
      try {
        const layout = await inspectMetadataLayout({
          signal: authority.settlementSignal,
          observeExecution: authority.trackFilesystem,
          purpose,
        });
        await authority.assertSettlementCurrent();
        if (layout.identity !== metadataIdentity)
          throw unavailable("The trusted Git metadata directory changed");
        if (
          purpose === "mutation" &&
          (!layout.storage ||
            layout.storage.alternates !== "absent_or_empty" ||
            layout.storage.grafts !== "absent_or_empty")
        )
          throw unavailable(
            "Native Git requires the verified mutation storage layout",
          );
        return layout;
      } catch (error) {
        markUnknown();
        throw error;
      }
    };
    return {
      authority,
      filesystem,
      metadataIdentity,
      verifyMetadata,
      verifyMutationMetadata: () => verifyMetadata("mutation"),
      get unknown() {
        return unknown;
      },
      async execute(input: {
        readonly args: readonly string[];
        readonly stdin?: string;
        readonly indexFile?: string;
        readonly timeoutMs?: number;
        readonly signal?: AbortSignal;
      }): Promise<GitCommandExecutionResult> {
        if (
          readOnly &&
          (input.indexFile !== undefined || input.stdin !== undefined)
        )
          throw unavailable(
            "Read-only Native Git rejected private index or stdin authority",
          );
        if (
          readOnly &&
          !(
            input.args[0] === "diff" ||
            (input.args[0] === "--no-optional-locks" &&
              input.args[1] === "status")
          )
        )
          throw unavailable(
            "Read-only Native Git requires a canonical status or diff query",
          );
        const args =
          readOnly && input.args[0] === "diff"
            ? ["diff", "--no-textconv", "--no-ext-diff", ...input.args.slice(1)]
            : input.args;
        const signal = readOnly
          ? AbortSignal.any([
              authority.signal,
              authority.settlementSignal,
              ...(input.signal ? [input.signal] : []),
            ])
          : (input.signal ?? authority.settlementSignal);
        if (
          input.stdin !== undefined &&
          Buffer.byteLength(input.stdin) > 1_000_000
        )
          throw unavailable("Native Git input exceeds its bound");
        const timeoutMs = input.timeoutMs ?? 30_000;
        if (
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 30_000
        )
          throw unavailable("Native Git deadline exceeds its bound");
        const activePreDispatch = async () => {
          signal.throwIfAborted();
          await authority.assertCurrent();
          signal.throwIfAborted();
        };
        const deadline = performance.now() + timeoutMs;
        if (readOnly) await activePreDispatch();
        const layout = await verifyMetadata();
        if (readOnly) await activePreDispatch();
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining < 1)
          return {
            exitCode: 124,
            stdout: "",
            stderr: "Native Git deadline expired before execution",
          };
        let operation: SingleProcessMacExecution | undefined;
        // An already-cancelled query has not constructed a process. Keep this
        // outside the uncertainty catch and immediately before the sync spawn.
        if (readOnly) signal.throwIfAborted();
        try {
          operation = executeSingleProcessMac({
            executable: options.gitExecutable,
            args: [
              "--no-replace-objects",
              ...(readOnly ? ["--literal-pathspecs"] : []),
              "-c",
              "maintenance.auto=false",
              "-c",
              "gc.auto=0",
              "-c",
              "core.fsmonitor=false",
              `--git-dir=${layout.gitDirectory}`,
              "--work-tree=.",
              ...args,
            ],
            cwd: authority.filesystemRoot,
            cwdFd: authority.rootDirectory.fd,
            writerLease: authority.writerLease,
            sandbox: {
              scope: "single_executable_nofork",
              filesystemRoot: authority.filesystemRoot,
            },
            processHelperPath: options.processHelperPath,
            trustedGitContext,
            readOnlyProbe: readOnly ? true : undefined,
            environment: {
              GIT_OPTIONAL_LOCKS: "0",
              ...(input.indexFile ? { GIT_INDEX_FILE: input.indexFile } : {}),
            },
            stdin: input.stdin,
            timeoutMs: remaining,
            signal,
          });
          authority.trackProcess(operation);
        } catch (error) {
          operation?.stop();
          markUnknown();
          throw new GitServiceError(
            "git_commit_indeterminate",
            "Native Git construction or process registration was not confirmed",
            {
              reason:
                error instanceof Error
                  ? error.message.slice(0, 1024)
                  : "Unknown construction failure",
            },
          );
        }
        let result;
        try {
          result = await operation.result;
        } catch (error) {
          markUnknown();
          throw new GitServiceError(
            "git_commit_indeterminate",
            "Native Git execution did not prove its outcome",
            {
              reason:
                error instanceof Error
                  ? error.message.slice(0, 1024)
                  : "Unknown execution failure",
            },
          );
        }
        if (!operation.quiescent || result.outputClosed) {
          markUnknown();
          throw new GitServiceError(
            "git_commit_indeterminate",
            "Native Git process closure was not proved",
          );
        }
        try {
          await authority.assertSettlementCurrent();
          const after = await verifyMetadata();
          if (
            after.gitDirectory !== layout.gitDirectory ||
            after.commonDirectory !== layout.commonDirectory ||
            after.backlinkPath !== layout.backlinkPath ||
            (!readOnly && performance.now() > deadline)
          )
            throw new Error(
              "Git metadata association or deadline changed during execution",
            );
        } catch (error) {
          markUnknown();
          throw new GitServiceError(
            "git_commit_indeterminate",
            "Native Git settlement could not be verified after execution",
            {
              reason:
                error instanceof Error
                  ? error.message.slice(0, 1024)
                  : "Unknown settlement failure",
            },
          );
        }
        // A readonly query's elapsed delivery budget cannot undo the ORIGINAL
        // positive process/pipe and metadata-identity closure proved above.
        if (readOnly && performance.now() > deadline)
          return {
            exitCode: 124,
            stdout: "",
            stderr: "Native Git read deadline expired",
          };
        if (result.truncated)
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Native Git output exceeded its bound",
          };
        return {
          exitCode: result.timedOut ? 124 : (result.exitCode ?? 1),
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    };
  };
}
