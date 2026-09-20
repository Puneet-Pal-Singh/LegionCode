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
  runLocalAppServerProcess(parentPort, data);
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
    value.serverVersion.length > 0
  );
}
