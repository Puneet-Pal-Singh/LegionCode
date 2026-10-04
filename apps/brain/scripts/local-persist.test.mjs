import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquireWorkerLock,
  attachWorkerGroup,
  prepareLocalPersistence,
  releaseWorkerLock,
  requireLocalPersistRoot,
  workerPersistPath,
} from "../../../scripts/local-dev/local-persist.mjs";

const brain = {
  name: "legioncode-brain",
  durable_objects: { bindings: [{ name: "RUNS", class_name: "RunRuntime" }] },
  migrations: [{ tag: "v1", new_classes: ["RunRuntime"] }],
};
const secureApi = {
  name: "legioncode-api",
  durable_objects: { bindings: [{ name: "AGENT", class_name: "AgentRuntime" }] },
  migrations: [{ tag: "v1", new_classes: ["AgentRuntime"] }],
};
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const localPersistScript = fileURLToPath(new URL("../../../scripts/local-dev/local-persist.mjs", import.meta.url));
const persistModuleUrl = new URL("../../../scripts/local-dev/local-persist.mjs", import.meta.url).href;
const supervisorPath = path.resolve(repositoryRoot, "scripts/local-dev/worker-group-supervisor.mjs");

function withRoot(callback) {
  const root = mkdtempSync(path.join(tmpdir(), "legioncode-local-persist-test-"));
  try {
    const result = callback(root);
    if (result && typeof result.then === "function") {
      return result.finally(() => rmSync(root, { recursive: true, force: true }));
    }
    rmSync(root, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test("requires an explicit absolute local persistence root", () => {
  assert.throws(() => requireLocalPersistRoot({}), /Set LEGIONCODE_LOCAL_PERSIST_DIR/);
  assert.throws(() => requireLocalPersistRoot({ LEGIONCODE_LOCAL_PERSIST_DIR: "relative" }), /absolute path/);
});

test("markers bind sanitized database identity and both worker migrations", () => {
  withRoot((base) => {
    const root = path.join(base, "runtime");
    const first = prepareLocalPersistence({
      persistRoot: root,
      databaseUrl: "postgres://user:secret@localhost:5432/chat-a",
      brainConfig: brain,
      secureApiConfig: secureApi,
    });
    assert.equal(first.root, root);
    const marker = readFileSync(path.join(root, ".legioncode-local-persistence.json"), "utf8");
    assert.doesNotMatch(marker, /secret|user:/);
    assert.equal(statSync(path.join(root, ".legioncode-local-persistence.json")).mode & 0o777, 0o600);
    assert.throws(() => prepareLocalPersistence({
      persistRoot: root,
      databaseUrl: "postgres://user:secret@localhost:5432/chat-b",
      brainConfig: brain,
      secureApiConfig: secureApi,
    }), /identity mismatch/);
    assert.throws(() => prepareLocalPersistence({
      persistRoot: root,
      databaseUrl: "postgres://user:secret@localhost:5432/chat-a",
      brainConfig: { ...brain, migrations: [{ tag: "v2", new_classes: ["RunRuntime"] }] },
      secureApiConfig: secureApi,
    }), /identity mismatch/);
  });
});

test("refuses to mark a pre-existing untracked worker namespace as fresh", () => {
  withRoot((root) => {
    const state = path.join(root, "runtime");
    mkdirSync(path.join(state, "workers", "brain"), { recursive: true });
    writeFileSync(path.join(state, "workers", "brain", "state.sqlite"), "existing");
    assert.throws(() => prepareLocalPersistence({
      persistRoot: state,
      databaseUrl: "postgres://user:secret@localhost:5432/chat-a",
      brainConfig: brain,
      secureApiConfig: secureApi,
    }), /unmarked state/);
  });
});

test("locks reject a second live writer and release by owner token", () => {
  withRoot((root) => {
    const lock = acquireWorkerLock({ root, role: "brain", ownerPid: process.pid, token: "test-token" });
    assert.throws(() => acquireWorkerLock({ root, role: "brain", token: "second-token" }), /already owns/);
    assert.equal(workerPersistPath(root, "brain"), path.join(root, "workers", "brain"));
    assert.equal(releaseWorkerLock(lock), true);
  });
});

test("local-persist CLI runs when invoked through a symlinked path", async () => {
  await withRoot(async (root) => {
    const aliasDirectory = path.join(root, "alias");
    mkdirSync(aliasDirectory);
    const alias = path.join(aliasDirectory, "local-persist.mjs");
    symlinkSync(localPersistScript, alias);
    const token = "symlink-cli-test";
    const child = spawn(process.execPath, [alias, "acquire", "brain", String(process.pid)], {
      env: { ...process.env, LEGIONCODE_LOCAL_PERSIST_DIR: root, LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN: token },
      stdio: "ignore",
    });
    await waitForExit(child);
    assert.equal(child.exitCode, 0);
    const record = JSON.parse(readFileSync(path.join(root, ".legioncode-worker-locks", "brain.json"), "utf8"));
    assert.equal(record.token, token);
    assert.equal(releaseWorkerLock({ role: "brain", lockPath: path.join(root, ".legioncode-worker-locks", "brain.json"), token, expectedOwnerPid: process.pid }), true);
  });
});

test("unknown process start or a foreign host never authorizes lock removal", () => {
  withRoot((root) => {
    const lockPath = path.join(root, ".legioncode-worker-locks", "secure-agent-api.json");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ format: 3, role: "secure-agent-api", ownerPid: 918273, host: hostname(), startedAt: new Date().toISOString(), workerGroupPid: null, token: "old-token" }));
    assert.throws(() => acquireWorkerLock({ root, role: "secure-agent-api", token: "replacement-token", processProbe: (pid) => pid === process.pid ? "alive" : "unknown" }), /already owns/);
    writeFileSync(lockPath, JSON.stringify({ format: 3, role: "secure-agent-api", ownerPid: 918273, host: "other-host", startedAt: new Date().toISOString(), workerGroupPid: null, token: "old-token" }));
    assert.throws(() => acquireWorkerLock({ root, role: "secure-agent-api", token: "replacement-token" }), /unknown or foreign/);
  });
});

test("reclaims only a format-3 stale lock after its owner is known dead", () => {
  withRoot((root) => {
    const deadPid = 918273;
    const lockPath = path.join(root, ".legioncode-worker-locks", "secure-agent-api.json");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ format: 3, role: "secure-agent-api", ownerPid: deadPid, host: hostname(), startedAt: new Date().toISOString(), workerGroupPid: null, token: "old-token" }));
    const replacement = acquireWorkerLock({ root, role: "secure-agent-api", ownerPid: process.pid, token: "replacement-token", processProbe: (pid) => pid === deadPid ? "dead" : "alive" });
    assert.equal(releaseWorkerLock(replacement), true);
  });
});

test("malformed format-3 process identity never authorizes stale lock removal", () => {
  withRoot((root) => {
    const lockPath = path.join(root, ".legioncode-worker-locks", "brain.json");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    for (const malformed of [
      { ownerPid: 0 },
      { ownerPid: "123" },
      { workerGroupPid: "not-a-pid" },
      { role: "secure-agent-api" },
      { token: "" },
      { startedAt: "not-a-date" },
    ]) {
      writeFileSync(lockPath, JSON.stringify({ format: 3, role: "brain", ownerPid: 987654321, host: hostname(), startedAt: new Date(0).toISOString(), workerGroupPid: null, token: "stale", ...malformed }));
      assert.throws(() => acquireWorkerLock({ root, role: "brain", token: "replacement" }), /unknown or foreign/);
    }
  });
});

test("both local launchers preflight and pass their explicit persistence namespaces to Wrangler", () => {
  const brainLauncher = readFileSync(path.join(repositoryRoot, "apps/brain/scripts/dev-with-secure-runtime.mjs"), "utf8");
  const pairedLauncher = readFileSync(path.join(repositoryRoot, "scripts/local-dev/run-workers-with-logs.sh"), "utf8");
  assert.match(brainLauncher, /requireLocalPersistRoot/);
  assert.match(brainLauncher, /--persist-to/);
  assert.match(brainLauncher, /workerPersistPath\(persistRoot, "brain"\)/);
  assert.match(brainLauncher, /workerPersistPath\(persistRoot, "secure-agent-api"\)/);
  assert.match(pairedLauncher, /LEGIONCODE_LOCAL_PERSIST_DIR/);
  assert.match(pairedLauncher, /--persist-to/);
  assert.match(pairedLauncher, /workers\/brain/);
  assert.match(pairedLauncher, /workers\/secure-agent-api/);
  assert.match(pairedLauncher, /acquire brain/);
  assert.match(pairedLauncher, /acquire secure-agent-api/);
  assert.match(brainLauncher, /worker-group-supervisor\.mjs/);
  assert.match(pairedLauncher, /worker-group-supervisor\.mjs/);
  assert.match(brainLauncher, /attachWorkerGroup\(lock, child\.pid\)/);
  assert.match(pairedLauncher, /attach brain "\$\{BRAIN_PID\}"/);
  assert.match(pairedLauncher, /attach secure-agent-api "\$\{SECURE_API_PID\}"/);
  assert.match(brainLauncher, /releaseWorkerLock/);
});

test("SIGKILLed launcher leaves a live worker group locked until the group dies", async () => {
  await withRoot(async (base) => {
    const root = path.join(base, "runtime");
    const marker = path.join(base, "writer-started");
    const ready = path.join(base, "launcher-ready.json");
    const launcher = startFixtureLauncher({ root, marker, ready, attach: true });
    try {
      const state = await waitForJson(ready);
      await waitFor(() => existsSync(marker));
      launcher.kill("SIGKILL");
      await waitForExit(launcher);
      assert.throws(() => acquireWorkerLock({ root, role: "brain", token: "second-writer" }), /may still be writing/);
      signalGroup(state.workerGroupPid, "SIGTERM");
      await waitFor(() => !groupAlive(state.workerGroupPid));
      const reclaimed = acquireWorkerLock({ root, role: "brain", token: "after-group-dead" });
      assert.equal(releaseWorkerLock(reclaimed), true);
    } finally {
      try { const state = JSON.parse(readFileSync(ready, "utf8")); signalGroup(state.workerGroupPid, "SIGKILL"); } catch {}
      if (launcher.exitCode === null) launcher.kill("SIGKILL");
    }
  });
});

test("launcher death before the durable group handshake starts zero writers", async () => {
  await withRoot(async (base) => {
    const root = path.join(base, "runtime");
    const marker = path.join(base, "writer-started");
    const ready = path.join(base, "launcher-ready.json");
    const launcher = startFixtureLauncher({ root, marker, ready, attach: false });
    const state = await waitForJson(ready);
    launcher.kill("SIGKILL");
    await waitForExit(launcher);
    await waitFor(() => !groupAlive(state.workerGroupPid));
    assert.equal(existsSync(marker), false);
    const reclaimed = acquireWorkerLock({ root, role: "brain", token: "after-unattached-exit" });
    assert.equal(releaseWorkerLock(reclaimed), true);
  });
});

test("simultaneous stale-lock contenders produce at most one lock owner", async () => {
  await withRoot(async (base) => {
    const root = path.join(base, "runtime");
    const lockPath = path.join(root, ".legioncode-worker-locks", "brain.json");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ format: 3, role: "brain", ownerPid: 987654321, host: hostname(), startedAt: new Date().toISOString(), workerGroupPid: null, token: "stale" }));
    const results = [path.join(base, "one.json"), path.join(base, "two.json")];
    const contenders = results.map((resultPath) => startLockContender(root, resultPath));
    try {
      const outcomes = await Promise.all(results.map(waitForJson));
      assert.equal(outcomes.filter((outcome) => outcome.acquired).length, 1);
      assert.equal(outcomes.filter((outcome) => !outcome.acquired).length, 1);
    } finally {
      for (const contender of contenders) if (contender.exitCode === null) contender.kill("SIGTERM");
      await Promise.all(contenders.map(waitForExit));
    }
  });
});

test("wrong token cannot release a lock and a live attached group blocks release", async () => {
  await withRoot(async (root) => {
    const lock = acquireWorkerLock({ root, role: "brain", token: "owner-token" });
    const group = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      await waitFor(() => groupAlive(group.pid));
      attachWorkerGroup(lock, group.pid);
      assert.equal(releaseWorkerLock({ ...lock, token: "wrong-token" }), false);
      assert.equal(releaseWorkerLock(lock), false);
    } finally {
      signalGroup(group.pid, "SIGTERM");
      await waitFor(() => !groupAlive(group.pid));
    }
    assert.equal(releaseWorkerLock(lock), true);
  });
});

function startFixtureLauncher({ root, marker, ready, attach }) {
  const source = `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const { acquireWorkerLock, attachWorkerGroup } = await import(${JSON.stringify(persistModuleUrl)});
    const root = process.env.TEST_PERSIST_ROOT;
    const lock = acquireWorkerLock({ root, role: "brain", token: "fixture-token" });
    const supervisor = spawn(process.execPath, [process.env.TEST_SUPERVISOR, "brain", String(process.pid), "--", process.execPath, "-e", ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`)}], {
      detached: true, stdio: "ignore", env: { ...process.env, LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN: lock.token },
    });
    if (${attach}) attachWorkerGroup(lock, supervisor.pid);
    writeFileSync(process.env.TEST_READY, JSON.stringify({ workerGroupPid: supervisor.pid }));
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, LEGIONCODE_LOCAL_PERSIST_DIR: root, TEST_PERSIST_ROOT: root, TEST_SUPERVISOR: supervisorPath, TEST_READY: ready },
    stdio: "ignore",
  });
}

function startLockContender(root, resultPath) {
  const source = `
    import { writeFileSync } from "node:fs";
    const { acquireWorkerLock } = await import(${JSON.stringify(persistModuleUrl)});
    try {
      const lock = acquireWorkerLock({ root: process.env.TEST_PERSIST_ROOT, role: "brain", token: process.env.TEST_TOKEN });
      writeFileSync(process.env.TEST_RESULT, JSON.stringify({ acquired: true, ownerPid: lock.ownerPid }));
      setInterval(() => {}, 1000);
    } catch (error) {
      writeFileSync(process.env.TEST_RESULT, JSON.stringify({ acquired: false, message: error.message }));
    }
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, LEGIONCODE_LOCAL_PERSIST_DIR: root, TEST_PERSIST_ROOT: root, TEST_RESULT: resultPath, TEST_TOKEN: path.basename(resultPath) },
    stdio: "ignore",
  });
}

async function waitForJson(filePath) {
  await waitFor(() => existsSync(filePath));
  return JSON.parse(readFileSync(filePath, "utf8"));
}

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for subprocess state");
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
}
