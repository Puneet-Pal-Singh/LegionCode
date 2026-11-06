import { createLocalNativeRuntime } from "@legioncode/app-server/local-native-runtime";
import { createNodeGitExecutor } from "@legioncode/app-server/local-node-git-executor";
import { DefaultGitService } from "@repo/git-service";
import { PermissionPolicySchema } from "@repo/permission-policy";
import { WorkerIdSchema, PermissionProfileIdSchema } from "@repo/platform-protocol";
import {
  runLocalAppServerProcess,
  type LocalAppServerMessage,
} from "@legioncode/app-server/local-process";
import { RuntimeCredentialClient, type RuntimeCredentialRequest } from "./runtime-credentials";
import type { LocalAppServerStartMessage } from "../shared/desktop-api";

const parentPort = (
  process as NodeJS.Process & {
    parentPort?: {
      on(
        event: "message",
        listener: (event: { data: unknown }) => void,
      ): void;
      postMessage(message: LocalAppServerMessage | RuntimeCredentialRequest): void;
    };
  }
).parentPort;
let started = false;

if (!parentPort) {
  throw new Error("Local App Server requires an Electron utility process");
}

const runtimeCredentials = new RuntimeCredentialClient((message) => parentPort.postMessage(message));
process.once("exit", () => runtimeCredentials.close());
process.once("disconnect", () => runtimeCredentials.close());

parentPort.on("message", ({ data }) => {
  if (runtimeCredentials.handleMessage(data)) return;
  if (!isStartMessage(data)) {
    parentPort?.postMessage({ type: "fatal" });
    return;
  }
  if (started) {
    return;
  }
  started = true;
  const helperPath = data.nativeFilesystemHelperPath;
  runLocalAppServerProcess(parentPort, data, {
    // Mac execution remains unavailable until its real contained Git/OS port is composed.
    createRuntime: helperPath && process.platform === "linux" ? ({ persistence }) => {
      const deny = { defaultEffect: "deny", defaultRiskLevel: "high", rules: [] };
      const permissionPolicy = PermissionPolicySchema.parse({
        commands: deny, network: deny, git: deny, packageManagers: deny,
        secrets: deny, externalServices: deny, tools: deny,
        paths: {
          ...deny,
          rules: [
            { id: "local-read", pattern: "read:*", effect: "allow", riskLevel: "low" },
            { id: "local-list", pattern: "list:*", effect: "allow", riskLevel: "low" },
          ],
        },
      });
      return createLocalNativeRuntime({
        persistence,
        workerId: WorkerIdSchema.parse("worker_localdesktop_readonly"),
        permissionProfileId: PermissionProfileIdSchema.parse("perm_localdesktop_readonly"),
        permissionPolicy,
        nativeFilesystemHelperPath: helperPath,
        resolveRuntimeCredential: (providerId, signal) => runtimeCredentials.resolveRuntimeCredential(providerId, signal),
        createGitService: (binding, signal) => {
          binding.assertCurrent();
          // The canonical adapter owns physical cancellation and process/pipe closure.
          return new DefaultGitService(createNodeGitExecutor({ signal }));
        },
      });
    } : undefined,
    resolveRuntimeCredential: (providerId, signal) => runtimeCredentials.resolveRuntimeCredential(providerId, signal),
  });
});

process.once("uncaughtException", () => {
  parentPort?.postMessage({ type: "fatal" });
  process.exit(1);
});

function isStartMessage(message: unknown): message is LocalAppServerStartMessage {
  if (!message || typeof message !== "object") {
    return false;
  }
  const value = message as Record<string, unknown>;
  return (
    value.type === "start" &&
    typeof value.credential === "string" &&
    value.credential.length >= 32 &&
    typeof value.serverVersion === "string" &&
    value.serverVersion.length > 0 &&
    typeof value.storageDirectory === "string" &&
    value.storageDirectory.startsWith("/") &&
    (value.protectedHostRoots === undefined || (
      Array.isArray(value.protectedHostRoots) && value.protectedHostRoots.length <= 32 &&
      value.protectedHostRoots.every((path: unknown) => typeof path === "string" && path.startsWith("/") && !path.includes("\0"))
    )) &&
    (value.nativeFilesystemHelperPath === undefined || (
      typeof value.nativeFilesystemHelperPath === "string" &&
      value.nativeFilesystemHelperPath.startsWith("/") && !value.nativeFilesystemHelperPath.includes("\0")
    )) &&
    (value.nativeProcessHelperPath === undefined || (
      typeof value.nativeProcessHelperPath === "string" &&
      value.nativeProcessHelperPath.startsWith("/") && !value.nativeProcessHelperPath.includes("\0")
    ))
  );
}
