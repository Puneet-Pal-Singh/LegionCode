import { NativeFilesystemBridge } from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import { LocalWorkspaceFilesService } from "@legioncode/app-server/local-workspace-files";
import {
  runLocalAppServerProcess,
  type LocalAppServerMessage,
} from "@legioncode/app-server/local-process";
import type { LocalAppServerStartMessage } from "../shared/desktop-api";

const parentPort = (
  process as NodeJS.Process & {
    parentPort?: {
      on(
        event: "message",
        listener: (event: { data: unknown }) => void,
      ): void;
      postMessage(message: LocalAppServerMessage): void;
    };
  }
).parentPort;
let started = false;

if (!parentPort) {
  throw new Error("Local App Server requires an Electron utility process");
}

parentPort.on("message", ({ data }) => {
  if (!isStartMessage(data)) {
    parentPort?.postMessage({ type: "fatal" });
    return;
  }
  if (started) {
    return;
  }
  started = true;
  runLocalAppServerProcess(parentPort, data, data.nativeFilesystemHelperPath ? {
    createWorkspaceFilesService: (workspaces) => new LocalWorkspaceFilesService({
      withWorkspace: async (workspaceId, operation) => {
        const binding = await workspaces.bindForExecution(workspaceId);
        try {
          binding.assertCurrent();
          const reader = new NativeFilesystemBridge({
            helperPath: data.nativeFilesystemHelperPath!, rootDirectory: binding.rootDirectory,
          });
          const result = await operation(reader, binding.signal);
          binding.assertCurrent();
          return result;
        } finally {
          // Native operations return only after child and pipe closure.
          await binding.close();
        }
      },
    }),
  } : undefined);
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
    [value.nativeFilesystemHelperPath, value.nativeProcessHelperPath].every((path) =>
      path === undefined || (typeof path === "string" && path.startsWith("/") && !path.includes("\0")),
    )
  );
}
