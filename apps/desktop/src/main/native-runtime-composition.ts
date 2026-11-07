import { realpathSync } from "node:fs";
import { createLocalNativeRuntime } from "@legioncode/app-server/local-native-runtime";
import { createLocalReadOnlyGitService } from "@legioncode/app-server/local-readonly-git";
import { LocalWorkspaceWriterLeaseOwner } from "@legioncode/app-server/local-workspace-writer-lease";
import { createLocalCapturedExecutionCapability } from "@legioncode/app-server/local-captured-execution";
import { createCaptureGitService } from "@legioncode/app-server/local-capture-git";
import type { LocalAppServerCompositionOptions } from "@legioncode/app-server/local-process";
import { NativePermissionPolicyResolver } from "@legioncode/execution-engine/runtime/engine/NativePermissionPolicyResolver";
import { PermissionProfileIdSchema, WorkerIdSchema } from "@repo/platform-protocol";
import type { LocalAppServerStartMessage } from "../shared/desktop-api";
import type { RuntimeCredentialClient } from "./runtime-credentials";
import { createWorkspaceFileComposition } from "./workspace-file-composition";

/** Trusted host adapters only; runtime owns admission, tools and lifecycle settlement. */
export async function createDesktopNativeComposition(
  config: LocalAppServerStartMessage,
  credentials: RuntimeCredentialClient,
): Promise<LocalAppServerCompositionOptions | undefined> {
  const files = createWorkspaceFileComposition(config);
  const filesystemHelperPath = config.nativeFilesystemHelperPath;
  const processHelperPath = config.nativeProcessHelperPath;
  if (!files || !filesystemHelperPath || !processHelperPath) return files;
  const gitExecutable = realpathSync("/usr/bin/git");
  const leases = config.nativeWriterFenceDirectory ? new LocalWorkspaceWriterLeaseOwner({
    trustedFenceDirectory: config.nativeWriterFenceDirectory,
    helperPath: processHelperPath,
  }) : undefined;
  return {
    ...files,
    createTurnRuntime: (persistence, media) => createLocalNativeRuntime({
      persistence,
      media,
      capability: leases ? createLocalCapturedExecutionCapability({
        persistence,
        leases,
        storageDirectory: config.storageDirectory,
        filesystemHelperPath,
        processHelperPath,
        createCaptureGitService: (lease, binding) => createCaptureGitService(lease, {
          gitExecutable,
          processHelperPath,
          filesystemHelperPath,
          metadataIdentity: binding.metadataIdentity,
          inspectMetadataLayout: binding.inspectMetadataLayout,
        }),
      }) : undefined,
      releaseExecution: leases ? (attempt, proof) => leases.releaseAttempt(attempt, proof) : undefined,
      workerId: WorkerIdSchema.parse("worker_localdesktop"),
      permissionProfileId: PermissionProfileIdSchema.parse("perm_localdesktop"),
      resolvePermissionPolicy: (productMode) => new NativePermissionPolicyResolver(productMode).resolve(),
      nativeFilesystemHelperPath: filesystemHelperPath,
      resolveRuntimeCredential: credentials.resolveRuntimeCredential.bind(credentials),
      createGitService: (binding, turnSignal) => createLocalReadOnlyGitService({
        purpose: "repo_probe",
        probeRoot: binding.filesystemRoot,
        withRootAuthority: binding.withRootAuthority,
        gitExecutable,
        processHelperPath,
        turnSignal,
      }),
    }),
  };
}
