import { RuntimeCredentialClient, type RuntimeCredentialRequest } from "./runtime-credentials";
import { createDesktopNativeComposition } from "./native-runtime-composition";
import {
  runLocalAppServerProcess,
  type LocalAppServerMessage,
  type LocalAppServerProcessControl,
} from "@legioncode/app-server/local-process";
import type { LocalAppServerShutdownMessage, LocalAppServerStartMessage } from "../shared/desktop-api";

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
let processControl: LocalAppServerProcessControl | undefined;
let shutdownRequested = false;
let shutdownStarted = false;
let retainedKeepAlive: ReturnType<typeof setInterval> | undefined;

if (!parentPort) {
  throw new Error("Local App Server requires an Electron utility process");
}

const runtimeCredentials = new RuntimeCredentialClient((message) => parentPort.postMessage(message));
process.once("exit", () => runtimeCredentials.close());
// Queue termination during async startup. The backend installs its own persistent
// SIGTERM handler before returning the actual resource-owning control.
process.on("SIGTERM", requestShutdown);

parentPort.on("message", ({ data }) => {
  if (runtimeCredentials.handleMessage(data)) return;
  if (isShutdownMessage(data)) {
    requestShutdown();
    return;
  }
  if (!isStartMessage(data)) {
    postFatal();
    requestShutdown();
    return;
  }
  if (started) {
    return;
  }
  started = true;
  void createDesktopNativeComposition(data, runtimeCredentials).then(async (composition) => {
    processControl = await runLocalAppServerProcess(parentPort, data, composition);
    if (!processControl) {
      retainUnknownClosure();
      return;
    }
    process.removeListener("SIGTERM", requestShutdown);
    if (shutdownRequested) requestShutdown();
  }).catch(() => {
    retainUnknownClosure();
    requestShutdown();
  });
});

process.on("uncaughtException", () => {
  retainUnknownClosure();
  requestShutdown();
});

function requestShutdown(): void {
  shutdownRequested = true;
  if (!processControl || shutdownStarted) return;
  shutdownStarted = true;
  try {
    // This call fences the actual owners synchronously, before waiting on them.
    const closed = processControl.requestShutdown();
    runtimeCredentials.close();
    void closed.catch(() => {
      // The backend retains the original owners and reports shutdown failure.
      // An observer or notification failure cannot authorize process exit.
      retainUnknownClosure();
    });
  } catch {
    retainUnknownClosure();
  }
}

function retainUnknownClosure(): void {
  retainedKeepAlive ??= setInterval(() => undefined, 1_000);
  postFatal("runtime-shutdown-failed");
}

function postFatal(reason?: "runtime-shutdown-failed"): void {
  try { parentPort?.postMessage({ type: "fatal", ...(reason ? { reason } : {}) }); }
  catch { /* A lost parent notification never releases uncertain owners. */ }
}

function isShutdownMessage(message: unknown): message is LocalAppServerShutdownMessage {
  return !!message && typeof message === "object" && Object.keys(message).length === 1 &&
    (message as { type?: unknown }).type === "shutdown";
}

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
    [value.nativeFilesystemHelperPath, value.nativeProcessHelperPath, value.nativeWriterFenceDirectory].every((path) =>
      path === undefined || (typeof path === "string" && path.startsWith("/") && !path.includes("\0")),
    )
  );
}
