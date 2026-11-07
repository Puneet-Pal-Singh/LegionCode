import { createVerifiedMacGitExecution, resolveTrustedMacGitExecutable } from "@legioncode/app-server/local-mac-git-execution";
import { NativeFilesystemBridge } from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import { LocalWorkspaceFilesService } from "@legioncode/app-server/local-workspace-files";
import type { LocalAppServerCompositionOptions } from "@legioncode/app-server/local-process";
import type { LocalAppServerStartMessage } from "../shared/desktop-api";

/** Trusted read-only host composition. No provider, Turn, transaction or process fallback. */
export function createWorkspaceFileComposition(
  config: LocalAppServerStartMessage,
): LocalAppServerCompositionOptions | undefined {
  const filesystemHelperPath = config.nativeFilesystemHelperPath;
  const processHelperPath = config.nativeProcessHelperPath;
  if (process.platform !== "darwin" || !filesystemHelperPath || !processHelperPath) return undefined;
  return {
    createMetadataInspector: (rootDirectory, observeExecution) =>
      new NativeFilesystemBridge({
        helperPath: filesystemHelperPath,
        rootDirectory,
        observeExecution,
      }),
    createProbeExecution: (authority) => createVerifiedMacGitExecution({
      ...authority, purpose: "repo_probe", gitExecutable: resolveTrustedMacGitExecutable(), processHelperPath,
    }),
    createWorkspaceFilesService: (workspaces) => new LocalWorkspaceFilesService({
      withWorkspace: async (workspaceId, operation) => {
        const binding = await workspaces.bindForExecution(workspaceId);
        try {
          binding.assertCurrent();
          const reader = new NativeFilesystemBridge({
            helperPath: filesystemHelperPath, rootDirectory: binding.rootDirectory,
          });
          // The native R/D bridge awaits child and pipe closure on both result and error paths.
          const result = await operation(reader, binding.signal);
          binding.assertCurrent();
          return result;
        } finally {
          await binding.close();
        }
      },
    }),
  };
}
