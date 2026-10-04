import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  LOCAL_WRANGLER_CONFIG_REMEDIATION,
  validateLocalWranglerConfig,
} from "./validate-local-wrangler-config.mjs";
import { validateSecureRuntimeLocalCapacity } from "../../secure-agent-api/scripts/validate-local-wrangler-config.mjs";
import {
  attachWorkerGroup,
  acquireWorkerLock,
  localWorkerConfigurations,
  prepareLocalPersistence,
  releaseWorkerLock,
  requireLocalPersistRoot,
  workerPersistPath,
} from "../../../scripts/local-dev/local-persist.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brainDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(brainDir, "..", "..");
const secureAgentApiDir = path.resolve(repoRoot, "apps", "secure-agent-api");
const secureRuntimePort = 8787;
const workerSupervisorPath = path.resolve(repoRoot, "scripts/local-dev/worker-group-supervisor.mjs");

const children = [];
const locks = [];
let shuttingDown = false;

main().catch((error) => {
  console.error("[brain/dev] failed to start local dev runtime", error);
  shutdown(1);
});

async function main() {
  if (!validateLocalWranglerConfig()) {
    console.error(LOCAL_WRANGLER_CONFIG_REMEDIATION);
    process.exitCode = 1;
    return;
  }
  validateSecureRuntimeLocalCapacity();

  const persistRoot = requireLocalPersistRoot();
  const localConfigPath = path.join(brainDir, "wrangler.local.jsonc");
  const configs = localWorkerConfigurations({
    repoRoot,
    brainLocalConfig: localConfigPath,
  });
  const hyperdrive = configs.brain.hyperdrive?.find(
    (entry) => entry.binding === "HYPERDRIVE",
  );
  prepareLocalPersistence({
    persistRoot,
    databaseUrl: hyperdrive?.localConnectionString,
    brainConfig: configs.brain,
    secureApiConfig: configs.secureApi,
  });
  const brainLock = acquireWorkerLock({ root: persistRoot, role: "brain" });
  const secureApiLock = acquireWorkerLock({ root: persistRoot, role: "secure-agent-api" });
  locks.push(brainLock, secureApiLock);

  await runCommand(
    "pnpm",
    ["--filter", "@legioncode/execution-engine", "build"],
    {
      cwd: repoRoot,
    },
  );

  const secureRuntimeAlreadyRunning = await isPortOpen(secureRuntimePort);
  if (secureRuntimeAlreadyRunning) {
    throw new Error(
      `Local startup is blocked: port ${secureRuntimePort} is already serving a worker outside this persistence lock. Stop that worker and restart with the configured persistence root.`,
    );
  }
  startPersistentProcess(
    "pnpm",
    [
      "exec", "wrangler", "dev", "--config", "wrangler.local.jsonc",
      "--port", "8787", "--inspector-port", "9229",
      "--persist-to", workerPersistPath(persistRoot, "secure-agent-api"),
    ],
    { cwd: secureAgentApiDir },
    "@legioncode/secure-agent-api",
    secureApiLock,
  );

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
      "--persist-to",
      workerPersistPath(persistRoot, "brain"),
    ],
    { cwd: brainDir },
    "@legioncode/brain",
    brainLock,
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

function startPersistentProcess(command, args, options, label, lock) {
  const child = spawn(process.execPath, [
    workerSupervisorPath,
    lock.role,
    String(process.pid),
    "--",
    command,
    ...args,
  ], {
    ...options,
    env: {
      ...process.env,
      LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN: lock.token,
    },
    stdio: "inherit",
    detached: true,
  });
  if (!child.pid) throw new Error(`${label} worker supervisor did not start`);
  children.push(child);
  attachWorkerGroup(lock, child.pid);
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

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    signalProcessGroup(child, "SIGTERM");
  }
  await Promise.race([Promise.all(children.map(waitForExit)), delay(2_000)]);
  for (const child of children) {
    if (processGroupAlive(child)) signalProcessGroup(child, "SIGKILL");
  }
  const deadline = Date.now() + 5_000;
  while (children.some(processGroupAlive) && Date.now() < deadline) await delay(50);
  if (children.some(processGroupAlive)) {
    console.error("[brain/dev] worker process group is still live; persistence locks are retained to prevent concurrent writers");
    process.exitCode = exitCode || 1;
    return;
  }
  for (const lock of locks.splice(0)) {
    if (!releaseWorkerLock(lock)) {
      console.error(`[brain/dev] ${lock.role} persistence lock was retained because ownership changed or its worker group may still be live`);
      exitCode ||= 1;
    }
  }
  process.exitCode = exitCode;
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

function processGroupAlive(child) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
