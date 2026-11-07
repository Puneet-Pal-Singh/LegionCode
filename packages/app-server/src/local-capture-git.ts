import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DefaultGitService } from "@repo/git-service";
import { GitServiceError } from "@repo/git-service/errors";
import type { GitCommandExecutor } from "@repo/git-service/executor";
import {
  NativeFilesystemBridge,
  parseNativeGitMetadataIdentity,
  type NativeGitMetadataIdentity,
} from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import {
  executeSingleProcessMac,
  type SingleProcessMacExecution,
} from "@legioncode/execution-engine/runtime/desktop/SingleExecutableProcess";
import type {
  LocalWorkspaceWriterAuthority,
  LocalWorkspaceWriterLease,
} from "./local-workspace-writer-lease.js";

export interface LocalCaptureGitOptions {
  readonly gitExecutable: string;
  readonly processHelperPath: string;
  readonly filesystemHelperPath: string;
  /** Captured by the trusted grant owner before its original Git probe. */
  readonly metadataIdentity: NativeGitMetadataIdentity;
}

const unavailable = (message: string) =>
  new GitServiceError("git_process_containment_unavailable", message);

/** Canonical snapshot/diff producer, bound to one retained physical attempt.
 * Workspace paths remain immutable labels; only the original FD is opened by
 * native helpers. No mutation capability is advertised by this narrow service.
 */
export function createCaptureGitService(
  lease: LocalWorkspaceWriterLease,
  options: LocalCaptureGitOptions,
): Pick<
  DefaultGitService,
  "captureSnapshot" | "getSnapshotDiff" | "probeRepository"
> {
  if (process.platform !== "darwin")
    throw unavailable("Native capture Git requires Darwin");
  for (const path of [
    options.gitExecutable,
    options.processHelperPath,
    options.filesystemHelperPath,
  ]) {
    if (!isAbsolute(path) || path.includes("\0") || realpathSync(path) !== path)
      throw unavailable(
        "Capture Git requires trusted canonical executable paths",
      );
  }
  const metadataIdentity = parseNativeGitMetadataIdentity(
    options.metadataIdentity,
  );
  const filesystem = (authority: LocalWorkspaceWriterAuthority) =>
    new NativeFilesystemBridge({
      helperPath: options.filesystemHelperPath,
      rootDirectory: authority.rootDirectory,
      writerLease: authority.writerLease,
      observeExecution: authority.trackFilesystem,
    });
  const executor = (
    authority: LocalWorkspaceWriterAuthority,
    bridge: NativeFilesystemBridge,
    markUnknown: () => void,
    snapshot?: { original: string; privatePath: string },
  ): GitCommandExecutor => ({
    async execute(input) {
      if (
        input.cwd !== authority.filesystemRoot ||
        (input.runId !== undefined && input.runId !== authority.attempt.runId)
      )
        throw unavailable("Capture Git belongs to another retained attempt");
      if (input.indexTransaction !== undefined)
        throw unavailable("Capture Git cannot commit an index transaction");
      const environment: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0" };
      for (const [key, value] of Object.entries(input.environment ?? {})) {
        if (
          key !== "GIT_INDEX_FILE" ||
          !snapshot ||
          (value !== `.git/${snapshot.original}` && value !== snapshot.original)
        )
          throw unavailable(
            "Capture Git rejected an index or environment selector",
          );
        environment.GIT_INDEX_FILE = snapshot.privatePath;
      }
      if (
        input.stdin !== undefined &&
        Buffer.byteLength(input.stdin) > 1_000_000
      )
        throw unavailable("Capture Git input exceeds its bound");
      const timeoutMs = input.timeoutMs ?? 30_000;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 30_000
      )
        throw unavailable("Capture Git deadline exceeds its bound");
      await authority.assertSettlementCurrent();
      if (
        (await bridge.inspectGitMetadataIdentity({
          signal: authority.settlementSignal,
        })) !== metadataIdentity
      )
        throw unavailable("The trusted Git metadata directory changed");
      await authority.assertSettlementCurrent();
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
          environment,
          stdin: input.stdin,
          timeoutMs,
          signal: authority.settlementSignal,
        });
        authority.trackProcess(operation);
      } catch (error) {
        operation?.stop();
        markUnknown();
        authority.markUnknown();
        throw error;
      }
      let result;
      try {
        result = await operation.result;
      } catch (error) {
        markUnknown();
        authority.markUnknown();
        throw error;
      }
      if (!operation.quiescent || result.outputClosed) {
        markUnknown();
        authority.markUnknown();
        throw new GitServiceError(
          "git_commit_indeterminate",
          "Capture Git process closure was not proved",
        );
      }
      await authority.assertSettlementCurrent();
      if (result.truncated)
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Capture Git output exceeded its bound",
        };
      return {
        exitCode: result.timedOut ? 124 : (result.exitCode ?? 1),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  });
  return {
    captureSnapshot: (input) =>
      lease.withSettlementAuthority(async (authority) => {
        if (
          input.workspace.filesystemRoot !== authority.filesystemRoot ||
          input.workspace.runId !== authority.attempt.runId
        )
          throw unavailable("Snapshot belongs to another retained attempt");
        const bridge = filesystem(authority);
        const original = `index.legioncode-${input.snapshotKey}`;
        let unknown = false;
        await authority.assertSettlementCurrent();
        if (
          (await bridge.inspectGitMetadataIdentity({
            signal: authority.settlementSignal,
          })) !== metadataIdentity
        )
          throw unavailable("The trusted Git metadata directory changed");
        return await bridge.withPrivateFileTransaction(
          {
            directory: ".git",
            file: original,
            expectedIdentity: metadataIdentity,
            signal: authority.settlementSignal,
            beforePublish: async () => {
              await authority.assertSettlementCurrent();
            },
          },
          async (session) => {
            try {
              const git = new DefaultGitService(
                executor(
                  authority,
                  bridge,
                  () => {
                    unknown = true;
                  },
                  { original, privatePath: session.filePath(original) },
                ),
              );
              const snapshot = await git.captureSnapshot(input);
              // Snapshot trees persist in Git; neither private indexes nor the real
              // user index are the captured artifact or a persistence owner.
              await session.abort();
              return snapshot;
            } catch (error) {
              if (!session.finalized) {
                if (unknown) await session.quarantine();
                else await session.abort();
              }
              throw error;
            }
          },
        );
      }),
    getSnapshotDiff: (input) =>
      lease.withSettlementAuthority(
        async (authority) =>
          await new DefaultGitService(
            executor(authority, filesystem(authority), () => undefined),
          ).getSnapshotDiff(input),
      ),
    probeRepository: (input) =>
      lease.withSettlementAuthority(
        async (authority) =>
          await new DefaultGitService(
            executor(authority, filesystem(authority), () => undefined),
          ).probeRepository(input),
      ),
  };
}
