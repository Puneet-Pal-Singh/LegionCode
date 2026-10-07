import net from "node:net";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  LOCAL_WRANGLER_CONFIG_REMEDIATION,
  validateLocalWranglerConfig,
} from "./validate-local-wrangler-config.mjs";
import { validateSecureRuntimeLocalCapacity } from "../../secure-agent-api/scripts/validate-local-wrangler-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brainDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(brainDir, "..", "..");
const secureAgentApiDir = path.resolve(repoRoot, "apps", "secure-agent-api");
const secureRuntimePort = 8787;
const persistRoot = process.env.LEGIONCODE_LOCAL_PERSIST_DIR;
const children = [];
let shuttingDown = false;

main().catch((error) => {
  console.error("[brain/dev] failed to start local dev runtime", error);
  void shutdown(1);
});

async function main() {
  if (!persistRoot || !path.isAbsolute(persistRoot)) {
    throw new Error("Set LEGIONCODE_LOCAL_PERSIST_DIR to an absolute path shared by local workers using the same database.");
  }
  if (!validateLocalWranglerConfig()) {
    console.error(LOCAL_WRANGLER_CONFIG_REMEDIATION);
    process.exitCode = 1;
    return;
  }
  validateSecureRuntimeLocalCapacity();
  mkdirSync(path.join(persistRoot, "workers", "brain"), { recursive: true });
  mkdirSync(path.join(persistRoot, "workers", "secure-agent-api"), { recursive: true });

  await runCommand(
    "pnpm",
    ["--filter", "@legioncode/execution-engine", "build"],
    { cwd: repoRoot },
  );

  if (await isPortOpen(secureRuntimePort)) {
    throw new Error(`Local startup is blocked: port ${secureRuntimePort} is already in use. Stop that worker and restart.`);
  }
  startWorker(
    "pnpm",
    ["exec", "wrangler", "dev", "--config", "wrangler.local.jsonc", "--port", "8787", "--inspector-port", "9229", "--persist-to", path.join(persistRoot, "workers", "secure-agent-api")],
    secureAgentApiDir,
    "@legioncode/secure-agent-api",
  );
  startWorker(
    "pnpm",
    ["exec", "wrangler", "dev", "--config", "wrangler.local.jsonc", "--port", "8788", "--inspector-port", "9230", "--persist-to", path.join(persistRoot, "workers", "brain")],
    brainDir,
    "@legioncode/brain",
  );
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, env: process.env, stdio: "inherit" });
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"} signal ${signal ?? "none"}`));
    });
    child.on("error", reject);
  });
}

function startWorker(command, args, cwd, label) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    detached: true,
  });
  if (!child.pid) throw new Error(`${label} worker did not start`);
  children.push(child);
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      if (code !== 0) console.error(`[brain/dev] ${label} exited with code ${code ?? "null"} signal ${signal ?? "none"}`);
      void shutdown(code ?? (signal ? 1 : 0));
    }
  });
  child.on("error", (error) => {
    if (!shuttingDown) {
      console.error(`[brain/dev] ${label} failed`, error);
      void shutdown(1);
    }
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) signalProcessGroup(child, "SIGTERM");
  await Promise.race([Promise.all(children.map(waitForExit)), delay(2_000)]);
  for (const child of children) {
    if (processGroupAlive(child)) signalProcessGroup(child, "SIGKILL");
  }
  process.exitCode = exitCode;
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
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

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(0));
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (result) => { socket.removeAllListeners(); socket.destroy(); resolve(result); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
