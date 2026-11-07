import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { GitServiceError } from "@repo/git-service/errors";
import type { GitCommandExecutionResult } from "@repo/git-service/executor";
import {
  NativeFilesystemBridge,
  parseNativeGitMetadataIdentity,
  type NativeGitMetadataIdentity,
} from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import {
  executeSingleProcessMac,
  type SingleProcessMacExecution,
} from "@legioncode/execution-engine/runtime/desktop/SingleExecutableProcess";
import type { LocalWorkspaceWriterAuthority } from "./local-workspace-writer-lease.js";
import { trustedLocalGitContext } from "./local-git-context.js";

export interface LocalNativeGitOptions {
  readonly gitExecutable: string;
  readonly processHelperPath: string;
  readonly filesystemHelperPath: string;
  /** Captured by the trusted grant owner before its original Git probe. */
  readonly metadataIdentity: NativeGitMetadataIdentity;
}

const unavailable = (message: string) =>
  new GitServiceError("git_process_containment_unavailable", message);

/** One OS binding shared by canonical capture and commit policies. */
export function createNativeGitBinding(options: LocalNativeGitOptions) {
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
    const verifyMetadata = async () => {
      await authority.assertSettlementCurrent();
      if (
        (await filesystem.inspectGitMetadataIdentity({
          signal: authority.settlementSignal,
        })) !== metadataIdentity
      )
        throw unavailable("The trusted Git metadata directory changed");
      await authority.assertSettlementCurrent();
    };
    return {
      authority,
      filesystem,
      metadataIdentity,
      verifyMetadata,
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
        await verifyMetadata();
        let operation: SingleProcessMacExecution | undefined;
        try {
          operation = executeSingleProcessMac({
            executable: options.gitExecutable,
            args: [
              "-c",
              "maintenance.auto=false",
              "-c",
              "gc.auto=0",
              "-c",
              "core.fsmonitor=false",
              "--git-dir=.git",
              "--work-tree=.",
              ...input.args,
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
            environment: {
              GIT_OPTIONAL_LOCKS: "0",
              ...(input.indexFile ? { GIT_INDEX_FILE: input.indexFile } : {}),
            },
            stdin: input.stdin,
            timeoutMs,
            signal: input.signal ?? authority.settlementSignal,
          });
          authority.trackProcess(operation);
        } catch (error) {
          operation?.stop();
          markUnknown();
          throw error;
        }
        let result;
        try {
          result = await operation.result;
        } catch (error) {
          markUnknown();
          throw error;
        }
        if (!operation.quiescent || result.outputClosed) {
          markUnknown();
          throw new GitServiceError(
            "git_commit_indeterminate",
            "Native Git process closure was not proved",
          );
        }
        await authority.assertSettlementCurrent();
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
