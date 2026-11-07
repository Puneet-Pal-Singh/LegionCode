import { DefaultGitService } from "@repo/git-service";
import { GitServiceError } from "@repo/git-service/errors";
import type { GitCommandExecutor } from "@repo/git-service/executor";
import {
  createNativeGitBinding,
  type LocalNativeGitOptions,
} from "./local-native-git.js";
import type { LocalWorkspaceWriterLease } from "./local-workspace-writer-lease.js";

export type LocalCaptureGitOptions = LocalNativeGitOptions;
const unavailable = (message: string) =>
  new GitServiceError("git_process_containment_unavailable", message);

/** Canonical snapshots through the original retained physical authority. */
export function createCaptureGitService(
  lease: LocalWorkspaceWriterLease,
  options: LocalCaptureGitOptions,
): Pick<
  DefaultGitService,
  "captureSnapshot" | "getSnapshotDiff" | "probeRepository"
> {
  const binding = createNativeGitBinding(options);
  const executor = (
    driver: ReturnType<typeof binding>,
    snapshot?: { original: string; privatePath: string },
  ): GitCommandExecutor => ({
    async execute(input) {
      if (
        input.cwd !== driver.authority.filesystemRoot ||
        (input.runId !== undefined &&
          input.runId !== driver.authority.attempt.runId) ||
        input.indexTransaction !== undefined
      )
        throw unavailable(
          "Capture Git belongs to another retained attempt or transaction",
        );
      let indexFile: string | undefined;
      for (const [key, value] of Object.entries(input.environment ?? {})) {
        if (
          key !== "GIT_INDEX_FILE" ||
          !snapshot ||
          (value !== `.git/${snapshot.original}` && value !== snapshot.original)
        )
          throw unavailable(
            "Capture Git rejected an index or environment selector",
          );
        indexFile = snapshot.privatePath;
      }
      return await driver.execute({ ...input, indexFile });
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
        const driver = binding(authority);
        const bridge = driver.filesystem;
        const original = `index.legioncode-${input.snapshotKey}`;
        await authority.assertSettlementCurrent();
        await driver.verifyMetadata();
        return await bridge.withPrivateFileTransaction(
          {
            directory: ".git",
            file: original,
            expectedIdentity: driver.metadataIdentity,
            signal: authority.settlementSignal,
            beforePublish: async () => {
              await authority.assertSettlementCurrent();
            },
          },
          async (session) => {
            try {
              const git = new DefaultGitService(
                executor(driver, {
                  original,
                  privatePath: session.filePath(original),
                }),
              );
              const snapshot = await git.captureSnapshot(input);
              // Snapshot trees persist in Git; neither private indexes nor the real
              // user index are the captured artifact or a persistence owner.
              await session.abort();
              return snapshot;
            } catch (error) {
              if (!session.finalized) {
                if (driver.unknown) await session.quarantine();
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
            executor(binding(authority)),
          ).getSnapshotDiff(input),
      ),
    probeRepository: (input) =>
      lease.withSettlementAuthority(
        async (authority) =>
          await new DefaultGitService(
            executor(binding(authority)),
          ).probeRepository(input),
      ),
  };
}
