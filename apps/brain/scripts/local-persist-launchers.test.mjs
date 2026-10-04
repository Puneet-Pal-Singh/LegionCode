import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquireWorkerLock, releaseWorkerLock } from "../../../scripts/local-dev/local-persist.mjs";
import { readJsonc } from "../../../scripts/local-dev/local-wrangler-config.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const moduleRoot = path.dirname(fileURLToPath(import.meta.url));

for (const launcherType of ["node", "shell"]) {
  test(`real ${launcherType} launcher records each worker group before the stub writer starts`, async () => {
    await withFixture(async (fixture) => {
      const setup = makeLauncherFixture(fixture, launcherType);
      const launcher = launcherType === "node"
        ? spawn(process.execPath, [setup.launcherPath], launcherOptions(setup))
        : spawn("bash", [setup.launcherPath], launcherOptions(setup));
      launcher.diagnostics = "";
      launcher.stdout.on("data", (data) => { launcher.diagnostics += data.toString(); });
      launcher.stderr.on("data", (data) => { launcher.diagnostics += data.toString(); });
      const groupIds = [];
      try {
        const brain = await waitForMarker(setup, "brain", launcher);
        const secure = await waitForMarker(setup, "secure-agent-api", launcher);
        for (const record of [brain, secure]) {
          assert.equal(record.lockGroup, record.processGroup);
          const lock = JSON.parse(readFileSync(path.join(setup.persistRoot, ".legioncode-worker-locks", `${record.role}.json`), "utf8"));
          assert.equal(lock.workerGroupPid, record.processGroup);
          groupIds.push(record.processGroup);
        }

        launcher.kill("SIGKILL");
        await waitForExit(launcher);
        for (const role of ["brain", "secure-agent-api"]) {
          assert.throws(() => acquireWorkerLock({ root: setup.persistRoot, role, token: "second-writer" }), /may still be writing/);
        }

        for (const groupId of groupIds) signalGroup(groupId, "SIGTERM");
        await waitFor(() => groupIds.every((groupId) => !groupAlive(groupId)));
        await waitFor(() => [brain, secure].every((record) => !pidAlive(record.writerPid)));
        for (const role of ["brain", "secure-agent-api"]) {
          const lock = acquireWorkerLock({ root: setup.persistRoot, role, token: `after-dead-${role}` });
          assert.equal(releaseWorkerLock(lock), true);
        }
      } finally {
        if (launcher.exitCode === null) launcher.kill("SIGKILL");
        for (const role of ["brain", "secure-agent-api"]) {
          const lockPath = path.join(setup.persistRoot, ".legioncode-worker-locks", `${role}.json`);
          try {
            const lock = JSON.parse(readFileSync(lockPath, "utf8"));
            if (lock.workerGroupPid != null && !groupIds.includes(lock.workerGroupPid)) groupIds.push(lock.workerGroupPid);
          } catch {}
        }
        for (const groupId of groupIds) { try { signalGroup(groupId, "SIGKILL"); } catch {} }
      }
    });
  });
}

function launcherOptions(setup) {
  return {
    cwd: setup.root,
    env: {
      ...process.env,
      PATH: `${setup.binDirectory}:${process.env.PATH}`,
      LEGIONCODE_LOCAL_PERSIST_DIR: setup.persistRoot,
      TEST_WRITER_MARKERS: setup.markerDirectory,
      TEST_WRITER_ERROR: setup.errorPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function makeLauncherFixture(base, launcherType) {
  const root = path.join(base, "repo");
  const persistRoot = path.join(base, "persist");
  const binDirectory = path.join(base, "bin");
  const markerDirectory = path.join(base, "markers");
  const errorPath = path.join(base, "launcher-error.log");
  for (const directory of [path.join(root, "apps/brain/scripts"), path.join(root, "apps/secure-agent-api/scripts"), path.join(root, "scripts/local-dev"), binDirectory, markerDirectory]) {
    mkdirSync(directory, { recursive: true });
  }

  copy("apps/brain/scripts/dev-with-secure-runtime.mjs", root);
  copy("apps/brain/scripts/validate-local-wrangler-config.mjs", root);
  copy("apps/secure-agent-api/scripts/validate-local-wrangler-config.mjs", root);
  copy("scripts/local-dev/local-persist.mjs", root);
  copy("scripts/local-dev/local-wrangler-config.mjs", root);
  copy("scripts/local-dev/worker-group-supervisor.mjs", root);
  copy("scripts/local-dev/run-workers-with-logs.sh", root);
  const brainCanonical = readJsonc(path.join(sourceRoot, "apps/brain/wrangler.jsonc"));
  const brainLocal = { ...brainCanonical, hyperdrive: [{ binding: "HYPERDRIVE", id: "test", localConnectionString: "postgres://user:pass@localhost:5432/chat" }] };
  writeFileSync(path.join(root, "apps/brain/wrangler.jsonc"), JSON.stringify(brainCanonical));
  writeFileSync(path.join(root, "apps/brain/wrangler.local.jsonc"), JSON.stringify(brainLocal));
  const apiCanonical = readJsonc(path.join(sourceRoot, "apps/secure-agent-api/wrangler.jsonc"));
  writeFileSync(path.join(root, "apps/secure-agent-api/wrangler.jsonc"), JSON.stringify(apiCanonical));
  writeFileSync(path.join(root, "apps/secure-agent-api/wrangler.local.jsonc"), JSON.stringify(apiCanonical));

  const stubPath = path.join(binDirectory, "pnpm");
  writeFileSync(stubPath, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--filter")) process.exit(0);
try {
  const cwd = process.cwd();
  const role = cwd.includes("/apps/brain") ? "brain" : "secure-agent-api";
  const root = process.env.LEGIONCODE_LOCAL_PERSIST_DIR;
  const lock = JSON.parse((await import("node:fs")).readFileSync(path.join(root, ".legioncode-worker-locks", role + ".json"), "utf8"));
  const actualGroup = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
  if (lock.workerGroupPid !== actualGroup) throw new Error("recorded process group does not match the writer process group");
  const directory = process.env.TEST_WRITER_MARKERS;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, role), JSON.stringify({ role, processGroup: actualGroup, lockGroup: lock.workerGroupPid, writerPid: process.pid }));
  setInterval(() => {}, 1000);
} catch (error) {
  writeFileSync(process.env.TEST_WRITER_ERROR, String(error?.stack ?? error));
  process.exit(7);
}
`);
  chmodSync(stubPath, 0o700);
  const launcherPath = path.join(root, launcherType === "node" ? "apps/brain/scripts/dev-with-secure-runtime.mjs" : "scripts/local-dev/run-workers-with-logs.sh");
  return { root, persistRoot, binDirectory, markerDirectory, errorPath, launcherPath };

  function copy(relative, destinationRoot) {
    const target = path.join(destinationRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(sourceRoot, relative), target);
  }
}

async function waitForMarker(setup, role, launcher) {
  const markerPath = path.join(setup.markerDirectory, role);
  await waitFor(() => {
    if (existsSync(setup.errorPath)) throw new Error(readFileSync(setup.errorPath, "utf8"));
    if (launcher.exitCode !== null) {
      const logs = ["brain.log", "secure-agent-api.log"].map((name) => {
        const logPath = path.join(path.dirname(setup.markerDirectory), "repo", "local", "logs", name);
        return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      }).join("\n");
      const lockState = ["brain", "secure-agent-api"].map((name) => {
        const lockPath = path.join(setup.persistRoot, ".legioncode-worker-locks", `${name}.json`);
        return `${name}: ${existsSync(lockPath) ? readFileSync(lockPath, "utf8") : "missing"}`;
      }).join("\n");
      throw new Error(`launcher exited ${launcher.exitCode}; ${launcher.diagnostics}\nlogs:\n${logs}\nlocks:\n${lockState}\nmarkers: ${existsSync(setup.markerDirectory) ? readdirSync(setup.markerDirectory).join(",") : "missing"}`);
    }
    return existsSync(markerPath);
  }, 15000);
  return { ...JSON.parse(readFileSync(markerPath, "utf8")), role };
}

async function withFixture(callback) {
  const directory = mkdtempSync(path.join(tmpdir(), "legioncode-local-launcher-test-"));
  try { await callback(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for launcher subprocess state");
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
}
