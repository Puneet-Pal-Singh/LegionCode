import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonc, durableObjectConfiguration } from "./local-wrangler-config.mjs";

const MARKER = ".legioncode-local-persistence.json";
const LOCK_DIR = ".legioncode-worker-locks";
const dirname = path.dirname(fileURLToPath(import.meta.url));

export function requireLocalPersistRoot(env = process.env) {
  const value = env.LEGIONCODE_LOCAL_PERSIST_DIR;
  if (!value) throw new Error("Set LEGIONCODE_LOCAL_PERSIST_DIR to an absolute persistent root shared by workers using the same local database.");
  if (!path.isAbsolute(value)) throw new Error("LEGIONCODE_LOCAL_PERSIST_DIR must be an absolute path.");
  return path.resolve(value);
}

export function prepareLocalPersistence({ persistRoot, databaseUrl, brainConfig, secureApiConfig }) {
  if (!path.isAbsolute(persistRoot)) throw new Error("Persistent root must be an absolute path.");
  const root = path.resolve(persistRoot);
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) throw new Error("Local database configuration is missing.");
  const identity = {
    format: 1,
    databaseFingerprint: databaseFingerprint(databaseUrl),
    workers: [workerFingerprint(brainConfig), workerFingerprint(secureApiConfig)].sort((a, b) => a.name.localeCompare(b.name)),
  };
  const fingerprint = hash(stableJson(identity));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const markerPath = path.join(root, MARKER);
  let existing;
  try {
    if (lstatSync(markerPath).isSymbolicLink()) throw new Error("symlink");
    existing = JSON.parse(readFileSync(markerPath, "utf8"));
  }
  catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Local persistence marker is unreadable; inspect it before starting workers.");
  }
  if (existing && (existing.format !== identity.format || existing.fingerprint !== fingerprint)) {
    throw new Error(`Local persistence identity mismatch at ${markerPath}. Set LEGIONCODE_LOCAL_PERSIST_DIR to the matching worker/database root or inspect the existing state; this startup will not initialize another namespace.`);
  }
  if (!existing) {
    const preexisting = readdirSync(root).filter((entry) => entry !== MARKER);
    if (preexisting.length > 0) {
      throw new Error(`Local persistence root ${root} already contains unmarked state. Recover or explicitly migrate that root before starting; startup will not bless a fresh namespace.`);
    }
    const marker = { ...identity, fingerprint, createdAt: new Date().toISOString() };
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  return { root, fingerprint, identity };
}

export function workerPersistPath(root, role) {
  return path.join(root, "workers", role);
}

export function acquireWorkerLock({ root, role, ownerPid = process.pid, token = randomBytes(32).toString("hex"), processProbe = processState, processGroupProbe = processGroupState }) {
  if (!/^[a-z0-9-]+$/.test(role)) throw new Error("Invalid local worker role.");
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || processProbe(ownerPid) !== "alive") throw new Error("Local worker lock owner process is not verifiably alive.");
  const lockRoot = path.join(root, LOCK_DIR);
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(lockRoot, `${role}.json`);
  return withAcquisitionMutex(lockRoot, () => {
    const lockRecord = { format: 3, role, ownerPid, host: hostname(), startedAt: new Date().toISOString(), workerGroupPid: null, token };
    let previous;
    try {
      if (lstatSync(lockPath).isSymbolicLink()) throw new Error("symlink");
      previous = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Local ${role} worker lock is unreadable at ${lockPath}; inspect it before starting.`);
    }
    if (previous) {
      if (previous.format !== 3 || previous.role !== role || previous.host !== hostname() || !Number.isInteger(previous.ownerPid) || previous.ownerPid <= 0 || typeof previous.token !== "string" || !previous.token || typeof previous.startedAt !== "string" || !Number.isFinite(Date.parse(previous.startedAt)) || !(previous.workerGroupPid === null || (Number.isInteger(previous.workerGroupPid) && previous.workerGroupPid > 0))) {
        throw new Error(`A local ${role} worker lock has unknown or foreign ownership evidence. Inspect it before starting.`);
      }
      if (processProbe(previous.ownerPid) !== "dead") {
        throw new Error(`A local ${role} worker already owns this persistence root (pid ${previous.ownerPid}); stop it before starting another.`);
      }
      if (previous.workerGroupPid != null && processGroupProbe(previous.workerGroupPid) !== "dead") {
        throw new Error(`A prior ${role} worker may still be writing to this persistence root. Inspect its worker process group and stale lock before retrying.`);
      }
      unlinkSync(lockPath);
    }
    const fd = openSync(lockPath, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(lockRecord)}\n`); }
    finally { closeSync(fd); }
    return { role, lockPath, token, ownerPid, startedAt: lockRecord.startedAt, workerGroupPid: null };
  });
}

export function attachWorkerGroup(lock, workerGroupPid, { processGroupProbe = processGroupState } = {}) {
  if (!lock?.lockPath || !lock?.token || !Number.isInteger(workerGroupPid) || workerGroupPid <= 0) throw new Error("Invalid worker group lock identity.");
  let groupState = processGroupProbe(workerGroupPid);
  const probeDeadline = Date.now() + 1000;
  while (groupState !== "alive" && Date.now() < probeDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    groupState = processGroupProbe(workerGroupPid);
  }
  if (groupState !== "alive") throw new Error("Worker process group is not verifiably alive before startup permission is recorded.");
  const lockRoot = path.dirname(lock.lockPath);
  return withAcquisitionMutex(lockRoot, () => {
    const current = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    if (current.token !== lock.token || current.ownerPid !== lock.ownerPid || current.host !== hostname() || current.startedAt !== lock.startedAt || current.workerGroupPid != null) {
      throw new Error("Local worker lock ownership changed before the worker group was recorded.");
    }
    const next = { ...current, workerGroupPid };
    const temporary = `${lock.lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, lock.lockPath);
    lock.workerGroupPid = workerGroupPid;
    return lock;
  });
}

export function releaseWorkerLock(lock) {
  if (!lock?.lockPath || !lock?.token) return false;
  try {
    const existing = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    if (existing.token !== lock.token || existing.ownerPid !== (lock.expectedOwnerPid ?? lock.ownerPid ?? process.pid) || existing.host !== hostname() || (lock.startedAt && existing.startedAt !== lock.startedAt) || (lock.workerGroupPid != null && existing.workerGroupPid !== lock.workerGroupPid)) return false;
    if (existing.workerGroupPid != null && processGroupState(existing.workerGroupPid) !== "dead") return false;
    const lockRoot = path.dirname(lock.lockPath);
    return withAcquisitionMutex(lockRoot, () => {
      const confirmed = JSON.parse(readFileSync(lock.lockPath, "utf8"));
      if (confirmed.token !== lock.token || confirmed.ownerPid !== existing.ownerPid || confirmed.host !== existing.host || confirmed.startedAt !== existing.startedAt || confirmed.workerGroupPid !== existing.workerGroupPid) return false;
      if (confirmed.workerGroupPid != null && processGroupState(confirmed.workerGroupPid) !== "dead") return false;
      unlinkSync(lock.lockPath);
      return true;
    });
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function withAcquisitionMutex(lockRoot, callback) {
  const mutexPath = path.join(lockRoot, ".acquisition-mutex");
  try { mkdirSync(mutexPath, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another local worker startup or lock transition is in progress; retry after it finishes. If the mutex owner crashed, inspect it before removing the stale mutex.");
    throw error;
  }
  try {
    writeFileSync(path.join(mutexPath, "owner.json"), JSON.stringify({ pid: process.pid, token: randomBytes(16).toString("hex") }), { mode: 0o600, flag: "wx" });
    return callback();
  } finally {
    try { unlinkSync(path.join(mutexPath, "owner.json")); } catch {}
    try { rmdirSync(mutexPath); } catch {}
  }
}

export function localWorkerConfigurations({ repoRoot, brainLocalConfig }) {
  return {
    brain: readJsonc(brainLocalConfig),
    secureApi: readJsonc(path.join(repoRoot, "apps", "secure-agent-api", "wrangler.local.jsonc")),
  };
}

function workerFingerprint(config) {
  const name = config?.name;
  if (typeof name !== "string" || !name) throw new Error("Worker configuration has no stable name.");
  const identity = { name, durableObjects: durableObjectConfiguration(config) };
  return { name, fingerprint: hash(stableJson(identity)) };
}

function databaseFingerprint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Local database URL is invalid."); }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/") {
    throw new Error("Local database URL must identify a PostgreSQL database.");
  }
  // Credentials, query values, and the URL itself are never written to the marker or logs.
  return hash([url.protocol, url.hostname.toLowerCase(), url.port || "5432", url.pathname].join("|"));
}

function stableJson(value) { return JSON.stringify(sort(value)); }
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
  return value;
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function isPidAlive(pid) {
  return processState(pid) !== "dead";
}
function processState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try { process.kill(pid, 0); return "alive"; }
  catch (error) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM") return "unknown";
    return "unknown";
  }
}

function processGroupState(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return "dead";
  try { process.kill(-pgid, 0); return "alive"; }
  catch (error) {
    if (error?.code === "ESRCH") return "dead";
    return "unknown";
  }
}

if (isCliEntrypoint(process.argv[1], fileURLToPath(import.meta.url))) {
  cli().catch((error) => {
    console.error(`[local-dev] ${error instanceof Error ? error.message : "Local persistence preflight failed."}`);
    process.exitCode = 1;
  });
}

function isCliEntrypoint(argvPath, modulePath) {
  if (!argvPath) return false;
  try { return realpathSync(argvPath) === realpathSync(modulePath); }
  catch { return false; }
}

async function cli() {
  const [command, role, ownerPidText] = process.argv.slice(2);
  const root = requireLocalPersistRoot();
  const token = process.env.LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN;
  if (command === "prepare") {
    const repoRoot = path.resolve(dirname, "..", "..");
    const brainLocalConfig = path.join(repoRoot, "apps", "brain", "wrangler.local.jsonc");
    const configs = localWorkerConfigurations({ repoRoot, brainLocalConfig });
    prepareLocalPersistence({ persistRoot: root, databaseUrl: configs.brain.hyperdrive?.find((entry) => entry.binding === "HYPERDRIVE")?.localConnectionString, brainConfig: configs.brain, secureApiConfig: configs.secureApi });
    return;
  }
  if (command === "acquire") {
    if (!token) throw new Error("Local worker lock token is not set in the environment.");
    acquireWorkerLock({ root, role, ownerPid: Number(ownerPidText), token });
    return;
  }
  if (command === "attach") {
    if (!token) throw new Error("Local worker lock token is not set in the environment.");
    const lockPath = path.join(root, LOCK_DIR, `${role}.json`);
    const record = JSON.parse(readFileSync(lockPath, "utf8"));
    attachWorkerGroup({ role, lockPath, token, ownerPid: record.ownerPid, startedAt: record.startedAt }, Number(ownerPidText));
    return;
  }
  if (command === "release") {
    if (!token) throw new Error("Local worker lock token is not set in the environment.");
    if (!releaseWorkerLock({ role, lockPath: path.join(root, LOCK_DIR, `${role}.json`), token, expectedOwnerPid: Number(ownerPidText) })) {
      throw new Error(`Could not release the ${role} worker lock: ownership changed or its worker process group may still be live.`);
    }
    return;
  }
  throw new Error("Usage: local-persist.mjs prepare | acquire ROLE PID | attach ROLE WORKER_GROUP_PID | release ROLE");
}
