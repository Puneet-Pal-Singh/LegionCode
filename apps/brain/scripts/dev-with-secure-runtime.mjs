import net from "node:net";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  LOCAL_WRANGLER_CONFIG_REMEDIATION,
  validateLocalWranglerConfig,
} from "./validate-local-wrangler-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brainDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(brainDir, "..", "..");
const secureAgentApiDir = path.resolve(repoRoot, "apps", "secure-agent-api");
const secureRuntimePort = 8787;

const children = [];
let shuttingDown = false;

main().catch((error) => {
  console.error("[brain/dev] failed to start local dev runtime", error);
  process.exit(1);
});

async function main() {
  if (!validateLocalWranglerConfig()) {
    console.error(LOCAL_WRANGLER_CONFIG_REMEDIATION);
    process.exitCode = 1;
    return;
  }

  await runCommand(
    "pnpm",
    ["--filter", "@shadowbox/execution-engine", "build"],
    {
      cwd: repoRoot,
    },
  );

  const secureRuntimeAlreadyRunning = await isPortOpen(secureRuntimePort);
  if (!secureRuntimeAlreadyRunning) {
    startPersistentProcess(
      "pnpm",
      ["dev"],
      { cwd: secureAgentApiDir },
      "@shadowbox/secure-agent-api",
    );
  } else {
    console.log(
      `[brain/dev] detected secure runtime on port ${secureRuntimePort}; reusing existing shadowbox-api session`,
    );
  }

  // Wrangler's tmp bundle can outlive source changes and execute an older
  // parameter mapping. Clear only generated build output; local state and
  // Durable Object data live under .wrangler/state and remain untouched.
  rmSync(path.join(brainDir, ".wrangler", "tmp"), {
    recursive: true,
    force: true,
  });

  startPersistentProcess(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "wrangler.local.jsonc",
      "--port",
      "8788",
      "--inspector-port",
      "9230",
    ],
    { cwd: brainDir },
    "@shadowbox/brain",
  );
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "null"} signal ${signal ?? "none"}`,
        ),
      );
    });
    child.on("error", reject);
  });
}

function startPersistentProcess(command, args, options, label) {
  const child = spawn(command, args, {
    ...options,
    env: process.env,
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const exitCode = code ?? (signal ? 1 : 0);
    if (exitCode !== 0) {
      console.error(
        `[brain/dev] ${label} exited unexpectedly with code ${code ?? "null"} signal ${signal ?? "none"}`,
      );
    }
    shutdown(exitCode);
  });
  child.on("error", (error) => {
    if (shuttingDown) {
      return;
    }
    console.error(`[brain/dev] ${label} failed`, error);
    shutdown(1);
  });
}

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 1_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
