import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { constants, chmodSync, closeSync, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readlinkSync, readdirSync, realpathSync, writeFileSync, fsyncSync, unlinkSync, symlinkSync, rmdirSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { qualificationConfigPath, qualificationControlProps, validateNativeQualificationIsolation } from "../gates/check-native-qualification-isolation.mjs";
import { readJsonc } from "./local-wrangler-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const app = resolve(root, "apps/secure-agent-api");
const require = createRequire(resolve(app, "package.json"));
const privateDirectory = resolve(root, "local/native-boundary-qualification");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const namespaceId = /^[a-f0-9]{32}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const unavailable = code => new Error(code);

function cliIdentity() {
  for (const name of ["CLOUDFLARE_API_BASE_URL", "WRANGLER_API_ENVIRONMENT", "WRANGLER_AUTH_DOMAIN", "WRANGLER_AUTH_URL", "WRANGLER_TOKEN_URL", "CLOUDFLARE_CONTAINER_REGISTRY"]) if (process.env[name] !== undefined) throw unavailable("PROVIDER_ENDPOINT_OVERRIDE_FORBIDDEN");
  const entry = require.resolve("wrangler");
  const directory = resolve(dirname(entry), "..");
  if (JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")).version !== "4.61.0") throw unavailable("WRANGLER_VERSION_UNREVIEWED");
  const executable = resolve(directory, "bin/wrangler.js");
  return { executable, entry, executableSha256: hash(readFileSync(executable)), entrySha256: hash(readFileSync(entry)) };
}

function nullLogSink() {
  ensurePrivateDirectory();
  const directory = mkdtempSync(resolve(privateDirectory, "cli-"), { encoding: "utf8" });
  const directoryIdentity = lstatSync(directory);
  const path = resolve(directory, "wrangler.log");
  symlinkSync(devNull, path);
  const identity = lstatSync(path);
  return { path, close() {
    const current = lstatSync(path);
    const currentDirectory = lstatSync(directory);
    if (!current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== process.getuid() || readlinkSync(path) !== devNull || !currentDirectory.isDirectory() || currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino || currentDirectory.uid !== process.getuid()) throw unavailable("CLI_LOG_SINK_IDENTITY_UNKNOWN");
    unlinkSync(path);
    rmdirSync(directory);
  } };
}

function configSnapshot(config, main = resolve(app, "src/qualification.ts")) {
  ensurePrivateDirectory();
  const directory = mkdtempSync(resolve(privateDirectory, "config-"), { encoding: "utf8" });
  const directoryIdentity = lstatSync(directory);
  const path = resolve(directory, "wrangler.json");
  const fd = openSync(path, constants.O_NOFOLLOW | constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  writeFileSync(fd, JSON.stringify({ ...config, main }));
  fsyncSync(fd);
  const identity = fstatSync(fd);
  return { path, close() {
    const current = lstatSync(path);
    const currentDirectory = lstatSync(directory);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || !currentDirectory.isDirectory() || currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino) throw unavailable("CONFIG_SNAPSHOT_IDENTITY_UNKNOWN");
    // Pinned Wrangler leaves these two empty parent directories after draining
    // its original build. Never recurse into or remove unexpected contents.
    const scratch = resolve(directory, ".wrangler");
    let scratchIdentity;
    try { scratchIdentity = lstatSync(scratch); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (scratchIdentity) {
      if (!scratchIdentity.isDirectory() || scratchIdentity.isSymbolicLink() || scratchIdentity.uid !== process.getuid()) throw unavailable("CONFIG_SCRATCH_IDENTITY_UNKNOWN");
      const temporary = resolve(scratch, "tmp");
      let temporaryIdentity;
      try { temporaryIdentity = lstatSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (temporaryIdentity) {
        if (!temporaryIdentity.isDirectory() || temporaryIdentity.isSymbolicLink() || temporaryIdentity.uid !== process.getuid()) throw unavailable("CONFIG_SCRATCH_IDENTITY_UNKNOWN");
        rmdirSync(temporary);
      }
      rmdirSync(scratch);
    }
    closeSync(fd);
    unlinkSync(path);
    rmdirSync(directory);
  } };
}

/** Preserve the original child's complete stdout/stderr/exit. Never infer
 * absence from a failed command, kill a child on a scenario timer, or print its
 * raw output (version metadata can contain operator PII and bindings). */
async function originalCli(identity, configPath, command, { format = "json", absentWorker, input } = {}) {
  const log = nullLogSink();
  // Wrangler's logger otherwise writes whoami PII into its global debug file.
  // Its supported logfile setting points at our exclusively owned null sink;
  // raw replies remain in memory, never a persistent log or receipt.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:HOME|PATH|TMPDIR|XDG_CONFIG_HOME|CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL|WRANGLER_HOME)$/.test(name)));
  Object.assign(env, { CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_SANITIZE: "true", WRANGLER_LOG_PATH: log.path });
  const child = spawn(process.execPath, [identity.executable, ...command, "--config", configPath, "--env-file", devNull], { cwd: app, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let total = 0;
  let overflow = false;
  let spawnFailed = false;
  let inputFailed = false;
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on("data", chunk => {
    (stream === child.stdout ? stdoutHash : stderrHash).update(chunk);
    total += chunk.length;
    if (total > 8 * 1024 * 1024) overflow = true;
    if (!overflow) chunks.push(chunk);
  });
  if (input !== undefined) { child.stdin.on("error", () => { inputFailed = true; }); child.stdin.end(input); }
  child.on("error", () => { spawnFailed = true; });
  const exit = await new Promise(resolveExit => child.on("close", (code, signal) => resolveExit({ code, signal })));
  log.close();
  const original = { command, stdoutSha256: stdoutHash.digest("hex"), stderrSha256: stderrHash.digest("hex"), exitCode: exit.code, signal: exit.signal, complete: !overflow && !spawnFailed && !inputFailed && exit.signal === null };
  const fail = code => { const error = unavailable(code); error.original = original; throw error; };
  if (!original.complete || hash(readFileSync(identity.executable)) !== identity.executableSha256 || hash(readFileSync(identity.entry)) !== identity.entrySha256) fail("PROVIDER_CLI_ORIGINAL_UNKNOWN");
  const out = Buffer.concat(stdout);
  const err = Buffer.concat(stderr);
  let text;
  let errorText;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(out); errorText = new TextDecoder("utf-8", { fatal: true }).decode(err); }
  catch { fail("PROVIDER_CLI_ENCODING_UNAVAILABLE"); }
  if (exit.code !== 0) {
    const resource = `/accounts/${absentWorker?.account}/workers/scripts/${absentWorker?.name}/deployments`;
    if (absentWorker && exit.code === 1 && errorText.includes(resource) && /\[code:\s*10007\]/.test(errorText)) return { absent: true, original };
    fail("PROVIDER_CLI_ORIGINAL_UNKNOWN");
  }
  if (format === "text") return { value: text, original };
  let value;
  try { value = JSON.parse(text); } catch { fail("PROVIDER_CLI_JSON_UNAVAILABLE"); }
  return { value, original };
}

async function providerInventory(config, configPath, identity = cliIdentity()) {
  const deployments = await originalCli(identity, configPath, ["deployments", "list", "--name", config.name, "--json"]);
  if (!Array.isArray(deployments.value) || deployments.value.length < 1) throw unavailable("DEPLOYMENT_METADATA_UNAVAILABLE");
  const deployment = deployments.value.at(-1);
  if (!object(deployment) || !uuid.test(deployment.id) || !Array.isArray(deployment.versions) || deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100 || !uuid.test(deployment.versions[0].version_id)) throw unavailable("DEPLOYMENT_METADATA_UNSUPPORTED");
  const version = await originalCli(identity, configPath, ["versions", "view", deployment.versions[0].version_id, "--name", config.name, "--json"]);
  if (!object(version.value) || version.value.id !== deployment.versions[0].version_id || !object(version.value.resources) || !Array.isArray(version.value.resources.bindings)) throw unavailable("VERSION_BINDING_METADATA_UNSUPPORTED");
  const containers = await originalCli(identity, configPath, ["containers", "list"]);
  if (!Array.isArray(containers.value)) throw unavailable("CONTAINER_LIST_METADATA_UNSUPPORTED");
  const matching = containers.value.filter(value => object(value) && value.name === config.containers[0].name);
  if (matching.length !== 1) throw unavailable("CONTAINER_IDENTITY_AMBIGUOUS");
  const container = matching[0];
  if (container.account_id !== config.account_id || container.scheduling_policy !== "default" || container.max_instances !== 1 || container.configuration?.image !== config.containers[0].image || container.configuration?.memory_mib !== 1024 || container.configuration?.vcpu !== 0.25) throw unavailable("CONTAINER_ACCOUNT_IMAGE_OR_RESOURCE_MISMATCH");
  const bindings = version.value.resources.bindings;
  const runtime = version.value.resources.script_runtime;
  if (!object(runtime) || runtime.migration_tag !== "native-qualification-v1" || runtime.compatibility_date !== config.compatibility_date || !same(runtime.compatibility_flags, config.compatibility_flags)) throw unavailable("PROVIDER_RUNTIME_MIGRATION_METADATA_UNAVAILABLE");
  if (!version.value.resources.script?.named_handlers?.some(handler => handler.name === "NativeBoundaryQualificationControl" && handler.handlers?.includes("fetch")) || typeof version.value.resources.script.etag !== "string") throw unavailable("PROVIDER_PRIVATE_ENTRYPOINT_METADATA_UNAVAILABLE");
  const expectedBindings = new Set(["AGENT_RUNTIME", "Sandbox", ...Object.keys(config.vars), ...(config.vars.NATIVE_QUALIFICATION_AUTHORITY_RECEIPT_SHA256 ? ["INTERNAL_RUNTIME_EVENT_SECRET"] : [])]);
  if (bindings.length !== expectedBindings.size || new Set(bindings.map(binding => binding.name)).size !== bindings.length) throw unavailable("PROVIDER_BINDING_INVENTORY_MISMATCH");
  for (const binding of bindings) {
    if (!expectedBindings.has(binding.name)) throw unavailable("PROVIDER_UNEXPECTED_RESOURCE_BINDING");
    if (binding.name === "INTERNAL_RUNTIME_EVENT_SECRET" ? binding.type !== "secret_text" : Object.hasOwn(config.vars, binding.name) && (binding.type !== "plain_text" || binding.text !== config.vars[binding.name])) throw unavailable("PROVIDER_VAR_OR_SECRET_METADATA_MISMATCH");
  }
  const namespaces = {};
  for (const [name, className] of [["AGENT_RUNTIME", "AgentRuntime"], ["Sandbox", "Sandbox"]]) {
    const matches = bindings.filter(binding => binding.type === "durable_object_namespace" && binding.name === name);
    if (matches.length !== 1 || matches[0].class_name !== className || !namespaceId.test(matches[0].namespace_id) || (matches[0].script_name !== undefined && matches[0].script_name !== config.name) || matches[0].environment !== undefined || matches[0].dispatch_namespace !== undefined) throw unavailable("PROVIDER_NAMESPACE_ALLOCATION_FIELDS_UNAVAILABLE");
    namespaces[name] = matches[0].namespace_id;
  }
  if (namespaces.AGENT_RUNTIME === namespaces.Sandbox || container.durable_objects?.namespace_id !== namespaces.Sandbox) throw unavailable("PROVIDER_NAMESPACE_DISJOINTNESS_MISMATCH");
  const principal = version.value.metadata?.author_id;
  if (typeof principal !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(principal)) throw unavailable("PROVIDER_VERSION_AUTHOR_ID_UNAVAILABLE");
  if (!uuid.test(container.id) || !Number.isFinite(Date.parse(container.created_at)) || !Number.isFinite(Date.parse(version.value.metadata?.created_on))) throw unavailable("PROVIDER_CREATION_IDENTITY_UNAVAILABLE");
  return { identity, originals: [deployments.original, version.original, containers.original], deployments: deployments.value, deployment, version: version.value, container, namespaces, principal };
}

const beneath = (directory, path) => path.startsWith(`${directory}${sep}`);
function filePin(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 64n * 1024n * 1024n) throw unavailable("BUILD_INPUT_TYPE_OR_SIZE_UNAVAILABLE");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.dev !== after.dev || current.ino !== after.ino) throw unavailable("BUILD_INPUT_CHANGED_DURING_CAPTURE");
    return { bytes, identity: { dev: after.dev.toString(), ino: after.ino.toString(), sha256: hash(bytes), size: after.size.toString() } };
  } finally { closeSync(fd); }
}
function committedBlob(path, bytes) {
  const name = relative(root, path);
  if (!beneath(realpathSync(root), path) || name.split(sep).some(part => part.startsWith("."))) throw unavailable("WORKSPACE_SOURCE_OUTSIDE_REVIEWED_TREE");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_PAGER: "cat" };
  let oid;
  let committed;
  try {
    oid = execFileSync("git", ["-C", root, "rev-parse", "--verify", `HEAD:${name}`], { env, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
    committed = execFileSync("git", ["-C", root, "cat-file", "blob", oid], { env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch { throw unavailable("WORKSPACE_SOURCE_NOT_COMMITTED"); }
  if (hash(committed) !== hash(bytes)) throw unavailable("WORKSPACE_SOURCE_DIFFERS_FROM_REVIEWED_BLOB");
  return oid;
}
function sourceGraph(metadata, map, base, identity) {
  if (!object(metadata.inputs) || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent) || map.sources.length !== map.sourcesContent.length) throw unavailable("BUILD_RESOLVED_GRAPH_UNAVAILABLE");
  const storeMarker = `${sep}node_modules${sep}.pnpm${sep}`;
  const index = realpathSync(identity.entry).indexOf(storeMarker);
  if (index < 0) throw unavailable("REVIEWED_DEPENDENCY_STORE_UNAVAILABLE");
  const store = realpathSync(identity.entry).slice(0, index + storeMarker.length - 1);
  const ownRoot = realpathSync(root);
  const graph = new Map();
  const add = path => {
    if (graph.has(path)) return graph.get(path);
    const physical = realpathSync(path);
    const pin = filePin(physical);
    const own = beneath(ownRoot, physical) && !physical.includes(`${sep}node_modules${sep}`);
    if (!own && !beneath(store, physical)) throw unavailable("RESOLVED_SOURCE_OUTSIDE_REVIEWED_TREE_OR_STORE");
    const record = { path, physical, ...pin.identity, kind: own ? "workspace" : "dependency", ...(own ? { blob: committedBlob(physical, pin.bytes) } : {}) };
    graph.set(path, record);
    return record;
  };
  for (const input of Object.keys(metadata.inputs)) {
    const path = resolve(base, input);
    const virtual = /^_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-(console|process)$/.test(basename(path)) && dirname(path) === resolve(dirname(realpathSync(identity.entry)), "..");
    if (virtual) {
      const position = map.sources.indexOf(input);
      if (position < 0 || typeof map.sourcesContent[position] !== "string") throw unavailable("BUILDER_VIRTUAL_INPUT_CONTENT_UNAVAILABLE");
      graph.set(path, { path, kind: "wrangler-virtual", sha256: hash(map.sourcesContent[position]) });
      continue;
    }
    const record = add(path);
    if (record.kind === "workspace") {
      const used = Object.values(metadata.outputs).some(output => output.inputs?.[input]?.bytesInOutput > 0);
      const position = map.sources.indexOf(input);
      if (used && (position < 0 || typeof map.sourcesContent[position] !== "string" || hash(map.sourcesContent[position]) !== record.sha256)) throw unavailable("COMPILED_WORKSPACE_SOURCE_MAP_MISMATCH");
    }
    let directory = dirname(record.physical);
    for (;;) {
      const packagePath = resolve(directory, "package.json");
      try {
        const pkg = JSON.parse(filePin(packagePath).bytes.toString("utf8"));
        if (record.kind === "dependency" && typeof pkg.name === "string" && /^@(repo|legioncode)\//.test(pkg.name)) throw unavailable("WORKSPACE_PACKAGE_ADOPTED_FROM_DEPENDENCY_STORE");
        add(packagePath);
        break;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const parent = dirname(directory);
      if (parent === directory) throw unavailable("RESOLVED_PACKAGE_METADATA_UNAVAILABLE");
      directory = parent;
    }
  }
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/secure-agent-api/package.json", "apps/secure-agent-api/tsconfig.json"]) add(resolve(root, name));
  const configs = new Set();
  const tsconfig = path => {
    if (configs.has(path)) return;
    configs.add(path);
    if (configs.size > 32) throw unavailable("BUILD_TSCONFIG_GRAPH_UNAVAILABLE");
    const pin = add(path);
    const config = readJsonc(pin.physical);
    for (const parent of config.extends === undefined ? [] : Array.isArray(config.extends) ? config.extends : [config.extends]) {
      if (typeof parent !== "string") throw unavailable("BUILD_TSCONFIG_GRAPH_UNAVAILABLE");
      tsconfig(createRequire(pin.physical).resolve(parent));
    }
  };
  tsconfig(resolve(app, "tsconfig.json"));
  return [...graph.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function outputPins(directory) {
  const result = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) result.push({ name: relative(directory, child), ...filePin(child).identity });
      else throw unavailable("BUILD_OUTPUT_LINK_OR_SPECIAL_FILE_FORBIDDEN");
    }
  };
  walk(directory);
  return result;
}
function verifySource(source, identity) {
  if (!object(source) || source.version !== 1 || !beneath(privateDirectory, source.directory) || realpathSync(source.directory) !== source.directory || !same(source.builder, identity) || !same(outputPins(source.directory), source.outputs)) throw unavailable("PINNED_BUILD_OUTPUT_CHANGED");
  const directory = lstatSync(source.directory);
  if (directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0 || (directory.mode & 0o200) !== 0) throw unavailable("PINNED_BUILD_DIRECTORY_UNAVAILABLE");
  for (const input of source.graph) {
    if (input.kind === "wrangler-virtual") continue;
    if (realpathSync(input.path) !== input.physical || !same(filePin(input.physical).identity, { dev: input.dev, ino: input.ino, sha256: input.sha256, size: input.size })) throw unavailable("REVIEWED_SOURCE_GRAPH_CHANGED");
  }
}
async function buildPinned(config, configPath, identity, registerIntent) {
  ensurePrivateDirectory();
  const directory = mkdtempSync(resolve(privateDirectory, "bundle-"), { encoding: "utf8" });
  const build = resolve(directory, "build");
  const deploy = resolve(directory, "deploy");
  mkdirSync(build, { mode: 0o700 });
  mkdirSync(deploy, { mode: 0o700 });
  const metadataPath = resolve(directory, "metadata.json");
  const command = ["deploy", "--dry-run", "--outdir", build, "--metafile", metadataPath, "--tsconfig", resolve(app, "tsconfig.json")];
  registerIntent({ directory, command });
  const compiled = await originalCli(identity, configPath, command, { format: "text" });
  registerIntent({ directory, command, original: compiled.original });
  const metadata = JSON.parse(filePin(metadataPath).bytes.toString("utf8"));
  if (!object(metadata.outputs)) throw unavailable("BUILD_OUTPUT_METADATA_UNAVAILABLE");
  for (const [path, output] of Object.entries(metadata.outputs)) {
    const physical = resolve(dirname(configPath), path);
    if (!beneath(build, physical) || filePin(physical).identity.size !== String(output.bytes)) throw unavailable("BUILD_OUTPUT_METADATA_MISMATCH");
  }
  const entries = Object.entries(metadata.outputs).filter(([, output]) => output.entryPoint !== undefined);
  if (entries.length !== 1) throw unavailable("BUILD_SINGLE_ENTRYPOINT_REQUIRED");
  const entry = resolve(dirname(configPath), entries[0][0]);
  if (!beneath(build, entry) || !entry.endsWith(".js")) throw unavailable("BUILD_ENTRYPOINT_OUTSIDE_PRIVATE_OUTPUT");
  const map = JSON.parse(filePin(`${entry}.map`).bytes.toString("utf8"));
  const graph = sourceGraph(metadata, map, dirname(configPath), identity);
  for (const output of Object.values(metadata.outputs)) for (const imported of output.imports ?? []) {
    if (!imported.external || /^(node|cloudflare):/.test(imported.path)) continue;
    if (!beneath(build, resolve(dirname(entry), imported.path))) throw unavailable("BUILD_EXTERNAL_IMPORT_OUTSIDE_PINNED_MODULES");
    filePin(resolve(dirname(entry), imported.path));
  }
  for (const output of outputPins(build)) {
    if (output.name === "README.md" || output.name.endsWith(".map")) continue;
    const destination = resolve(deploy, output.name);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(resolve(build, output.name), destination, constants.COPYFILE_EXCL);
  }
  const seal = path => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, item.name);
      if (item.isDirectory()) seal(child);
      else if (item.isFile()) {
        chmodSync(child, 0o400);
        const fd = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } else throw unavailable("BUILD_OUTPUT_LINK_OR_SPECIAL_FILE_FORBIDDEN");
    }
    chmodSync(path, 0o500);
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  seal(directory);
  const parent = openSync(privateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  const source = { version: 1, directory, entry: resolve(deploy, relative(build, entry)), builder: identity, graph, outputs: outputPins(directory), buildOriginal: compiled.original };
  verifySource(source, identity);
  return source;
}
async function deployPinned(config, source, identity) {
  verifySource(source, identity);
  const snapshot = configSnapshot(config, source.entry);
  try {
    const original = await originalCli(identity, snapshot.path, ["deploy", "--no-bundle", "--name", config.name, "--strict"], { format: "text" });
    verifySource(source, identity);
    return original;
  } finally { snapshot.close(); }
}
async function authenticatedOperator(identity, config, configPath) {
  const whoami = await originalCli(identity, configPath, ["whoami", "--account", config.account_id], { format: "text" });
  if (!/You are logged in with an? /.test(whoami.value) || !whoami.value.includes(config.account_id)) throw unavailable("AUTHENTICATED_SELECTED_ACCOUNT_UNAVAILABLE");
  return { accountId: config.account_id, receiptSha256: hash(JSON.stringify(canonical(whoami.original))), original: whoami.original };
}
function closeState(state) {
  const held = fstatSync(state.lock);
  const current = lstatSync(state.lockPath);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino) throw unavailable("PROTECTED_STATE_LOCK_IDENTITY_UNKNOWN");
  closeSync(state.fd);
  closeSync(state.lock);
  unlinkSync(state.lockPath);
}

/** A single protected attempt precedes every provider mutation. No adoption,
 * transfer, rename, imported namespace or retry authority exists in the config. */
async function createSealed(config, configPath, attemptId) {
  const identity = cliIdentity();
  const operator = await authenticatedOperator(identity, config, configPath);
  const before = await originalCli(identity, configPath, ["containers", "list"]);
  if (!Array.isArray(before.value) || before.value.some(app => app.name === config.containers[0].name)) throw unavailable("EXISTING_CONTAINER_TARGET_COLLISION");
  const absence = await originalCli(identity, configPath, ["deployments", "list", "--name", config.name, "--json"], { absentWorker: { account: config.account_id, name: config.name } });
  if (absence.absent !== true) throw unavailable("EXISTING_WORKER_TARGET_COLLISION");
  const stateFile = openPrivateState(config.vars.NATIVE_QUALIFICATION_ENVIRONMENT_ID, true, "creation");
  let intent = { version: 1, purpose: "native_boundary_qualification_creation", attemptId, worker: config.name, containerName: config.containers[0].name, accountId: config.account_id, environmentId: config.vars.NATIVE_QUALIFICATION_ENVIRONMENT_ID, expectedPrincipal: config.vars.NATIVE_QUALIFICATION_CONTROL_PRINCIPAL, operatorReceiptSha256: operator.receiptSha256, cli: identity, configSha256: hash(JSON.stringify(canonical(config))), image: config.containers[0].image, startedAt: Date.now(), phase: "unknown", pendingAction: "build-sealed", originals: [operator.original, before.original, absence.original] };
  saveState(stateFile.fd, intent);
  try {
    const source = await buildPinned(config, configPath, identity, buildIntent => { intent = { ...intent, buildIntent }; saveState(stateFile.fd, intent); });
    intent = { ...intent, source, pendingAction: "deploy-sealed", originals: [...intent.originals, source.buildOriginal] };
    saveState(stateFile.fd, intent);
    const deployed = await deployPinned(config, source, identity);
    const inventory = await providerInventory(config, configPath, identity);
    const creation = `Created application ${config.containers[0].name} (Application ID: ${inventory.container.id})`;
    const createdAt = Date.parse(inventory.container.created_at);
    if (!deployed.value.includes(creation) || inventory.deployments.length !== 1 || inventory.version.number !== 1 || createdAt < intent.startedAt - 60_000 || createdAt > Date.now() + 60_000 || Date.parse(inventory.version.metadata.created_on) < intent.startedAt - 60_000 || before.value.some(app => app.id === inventory.container.id || app.durable_objects?.namespace_id === inventory.namespaces.Sandbox || app.durable_objects?.namespace_id === inventory.namespaces.AGENT_RUNTIME)) throw unavailable("PROVIDER_NEW_ALLOCATION_RECEIPT_UNAVAILABLE");
    if (config.vars.NATIVE_QUALIFICATION_CONTROL_PRINCIPAL !== undefined && config.vars.NATIVE_QUALIFICATION_CONTROL_PRINCIPAL !== inventory.principal) throw unavailable("PROVIDER_CREATION_PRINCIPAL_MISMATCH");
    verifySource(source, identity);
    const receipt = { version: 1, purpose: "native_boundary_qualification_creation", attemptId, worker: config.name, containerName: config.containers[0].name, accountId: config.account_id, environmentId: config.vars.NATIVE_QUALIFICATION_ENVIRONMENT_ID, operatorReceiptSha256: operator.receiptSha256, controlPrincipal: inventory.principal, namespaces: inventory.namespaces, applicationId: inventory.container.id, applicationCreatedAt: inventory.container.created_at, firstVersionId: inventory.version.id, firstDeploymentId: inventory.deployment.id, scriptEtag: inventory.version.resources.script.etag, image: config.containers[0].image, source: intent.source, cli: identity, originals: [...intent.originals, deployed.original, ...inventory.originals] };
    const receiptSha256 = hash(JSON.stringify(canonical(receipt)));
    saveState(stateFile.fd, { ...intent, phase: "created-sealed", pendingAction: undefined, receipt, receiptSha256 });
    console.log(JSON.stringify({ phase: "created-sealed", authorityReceiptSha256: receiptSha256, runtimeQualified: false }));
  } catch (error) {
    saveState(stateFile.fd, { ...intent, phase: "unknown", failureOriginal: error.original });
    throw error;
  } finally { closeState(stateFile); }
}

function checkCreation(config, state, inventory) {
  const receipt = state.receipt;
  if (!object(receipt) || state.pendingAction !== undefined || hash(JSON.stringify(canonical(receipt))) !== state.receiptSha256 || receipt.accountId !== config.account_id || receipt.worker !== config.name || receipt.environmentId !== config.vars.NATIVE_QUALIFICATION_ENVIRONMENT_ID || receipt.controlPrincipal !== config.vars.NATIVE_QUALIFICATION_CONTROL_PRINCIPAL || receipt.image !== config.containers[0].image || state.receiptSha256 !== config.vars.NATIVE_QUALIFICATION_AUTHORITY_RECEIPT_SHA256 || !same(receipt.cli, inventory.identity) || !same(receipt.source, state.source) || receipt.applicationId !== inventory.container.id || receipt.applicationCreatedAt !== inventory.container.created_at || !same(receipt.namespaces, inventory.namespaces) || receipt.controlPrincipal !== inventory.principal || receipt.scriptEtag !== inventory.version.resources.script.etag) throw unavailable("CREATION_RECEIPT_OR_CURRENT_TARGET_MISMATCH");
  verifySource(receipt.source, inventory.identity);
  return receipt;
}

async function activate(config, configPath, attemptId) {
  const secret = process.env.INTERNAL_RUNTIME_EVENT_SECRET;
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw unavailable("FRESH_QUALIFICATION_SECRET_UNAVAILABLE");
  const stateFile = openPrivateState(config.vars.NATIVE_QUALIFICATION_ENVIRONMENT_ID, false, "creation");
  let state;
  try {
    state = readState(stateFile.fd);
    if (state.phase !== "created-sealed" || state.attemptId !== attemptId || state.pendingAction !== undefined) throw unavailable("CREATION_ORIGINAL_RETAINED_NO_RETRY");
    const sealed = { ...config, vars: Object.fromEntries(Object.entries(config.vars).filter(([name]) => !["NATIVE_QUALIFICATION_IMAGE_DIGEST", "NATIVE_QUALIFICATION_HELPER_SHA256", "NATIVE_QUALIFICATION_POLICY_SHA256", "NATIVE_QUALIFICATION_AUTHORITY_RECEIPT_SHA256"].includes(name))) };
    // Source callers may learn the actual principal only after first allocation.
    // Current sealed metadata is checked with the original config, not guessed.
    const sealedPath = resolve(privateDirectory, `${attemptId}.sealed.json`);
    let sealedCreated = false;
    try {
      const originalVars = { ENVIRONMENT: "native-boundary-qualification", NATIVE_QUALIFICATION_ENVIRONMENT_ID: config.vars.NATIVE_QUALIFICATION_ENVIRONMENT_ID, NATIVE_QUALIFICATION_OPERATOR_ACCOUNT_ID: config.account_id };
      if (state.expectedPrincipal !== undefined) originalVars.NATIVE_QUALIFICATION_CONTROL_PRINCIPAL = state.expectedPrincipal;
      writeFileSync(sealedPath, JSON.stringify({ ...sealed, main: resolve(app, "src/qualification.ts"), vars: originalVars }), { flag: "wx", mode: 0o600 });
      sealedCreated = true;
      const inventory = await providerInventory({ ...sealed, vars: originalVars }, sealedPath);
      checkCreation(config, state, inventory);
      const operator = await authenticatedOperator(inventory.identity, config, configPath);
      if (operator.receiptSha256 !== state.operatorReceiptSha256) throw unavailable("AUTHENTICATED_CREATION_OPERATOR_CHANGED");
      verifySource(state.source, inventory.identity);
      saveState(stateFile.fd, { ...state, phase: "unknown", pendingAction: "activate-secret" });
      const secretOriginal = await originalCli(inventory.identity, configPath, ["secret", "put", "INTERNAL_RUNTIME_EVENT_SECRET"], { format: "text", input: `${secret}\n` });
      saveState(stateFile.fd, { ...state, phase: "unknown", pendingAction: "activate-deploy", secretOriginal: secretOriginal.original });
      const deployOriginal = await deployPinned(config, state.source, inventory.identity);
      const active = await providerInventory(config, configPath, inventory.identity);
      checkCreation(config, state, active);
      saveState(stateFile.fd, { ...state, phase: "active", pendingAction: undefined, activeConfigSha256: hash(JSON.stringify(canonical(config))), activationOriginals: [operator.original, secretOriginal.original, deployOriginal.original, ...active.originals] });
      console.log(JSON.stringify({ phase: "active", runtimeQualified: false }));
    } finally { if (sealedCreated) unlinkSync(sealedPath); }
  } catch (error) {
    // Never clear a persisted pending mutation because a later read failed.
    if (state) { const current = readState(stateFile.fd); if (current.pendingAction !== undefined) saveState(stateFile.fd, { ...current, phase: "unknown", failureOriginal: error.original }); }
    throw error;
  } finally { closeState(stateFile); }
}

function ensurePrivateDirectory() {
  const local = resolve(root, "local");
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const localIdentity = lstatSync(local);
  if (!localIdentity.isDirectory() || localIdentity.isSymbolicLink() || localIdentity.uid !== process.getuid()) throw unavailable("PROTECTED_STATE_PARENT_UNAVAILABLE");
  mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  const directory = lstatSync(privateDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0) throw unavailable("PROTECTED_STATE_DIRECTORY_UNAVAILABLE");
}

function openPrivateState(operationId, create, kind = "operation") {
  ensurePrivateDirectory();
  const path = resolve(privateDirectory, `${operationId}.${kind}.json`);
  const lockPath = `${path}.lock`;
  const lock = openSync(lockPath, constants.O_NOFOLLOW | constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const fd = openSync(path, constants.O_NOFOLLOW | constants.O_RDWR | constants.O_APPEND | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) { closeSync(fd); throw unavailable("PROTECTED_STATE_UNAVAILABLE"); }
    const directory = openSync(privateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return { fd, lock, lockPath };
  } catch (error) { closeSync(lock); unlinkSync(lockPath); throw error; }
}
function saveState(fd, state) {
  // Append durable records on the same held inode. An incomplete final record
  // makes recovery unknown; it never restores an earlier dispatchable state.
  writeFileSync(fd, `${JSON.stringify(state)}\n`);
  fsyncSync(fd);
}
function readState(fd) {
  const size = fstatSync(fd).size;
  if (!Number.isSafeInteger(size) || size < 1 || size > 4 * 1024 * 1024) throw unavailable("PROTECTED_STATE_SIZE_UNAVAILABLE");
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, offset, size - offset, offset);
    if (count === 0) throw unavailable("PROTECTED_STATE_ORIGINAL_UNKNOWN");
    offset += count;
  }
  const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (!content.endsWith("\n")) throw unavailable("PROTECTED_STATE_ORIGINAL_UNKNOWN");
  const lines = content.trimEnd().split("\n");
  const state = JSON.parse(lines.at(-1));
  if (!object(state)) throw unavailable("PROTECTED_STATE_MALFORMED");
  return state;
}
function validateReply(reply, config, operationId, action) {
  const subject = { ...qualificationControlProps(config), operationId };
  const pins = { imageDigest: config.vars.NATIVE_QUALIFICATION_IMAGE_DIGEST, helperSha256: config.vars.NATIVE_QUALIFICATION_HELPER_SHA256, policySha256: config.vars.NATIVE_QUALIFICATION_POLICY_SHA256 };
  const lease = reply?.lease;
  const phases = ["reserved", "starting", "observed", "provisioning", "provisioned", "retiring", "retired", "unknown"];
  if (!object(reply) || reply.purpose !== "native_boundary_qualification" || !same(reply.subject, subject) || !same(reply.pins, pins) || !object(lease) || lease.generation !== 0 || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= 0 || !sha.test(lease.sandboxObjectId) || !sha.test(lease.ownerId) || ![lease.sessionId, lease.leaseId, lease.sandboxId, lease.physicalAttemptKey].every(value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)) || reply.authorityDigest !== hash(JSON.stringify(canonical({ subject, pins, lease }))) || !phases.includes(reply.phase) || typeof reply.originalTransportSettled !== "boolean" || reply.active !== (reply.phase !== "retired") || reply.runtimeQualified !== false) throw unavailable("PRIVATE_CONTROL_REPLY_UNAVAILABLE");
  if (action === "reserve" ? !sha.test(reply.bearer) : reply.bearer !== undefined) throw unavailable("PRIVATE_CONTROL_BEARER_UNAVAILABLE");
  return reply;
}

async function controlInventory(config, configPath) {
  const stateFile = openPrivateState(config.vars.NATIVE_QUALIFICATION_ENVIRONMENT_ID, false, "creation");
  try {
    const state = readState(stateFile.fd);
    if (state.phase !== "active" || state.pendingAction !== undefined || state.activeConfigSha256 !== hash(JSON.stringify(canonical(config)))) throw unavailable("ACTIVATION_ORIGINAL_UNAVAILABLE");
    const inventory = await providerInventory(config, configPath);
    checkCreation(config, state, inventory);
    const operator = await authenticatedOperator(inventory.identity, config, configPath);
    if (operator.receiptSha256 !== state.operatorReceiptSha256) throw unavailable("AUTHENTICATED_CREATION_OPERATOR_CHANGED");
    return inventory;
  } finally { closeState(stateFile); }
}

/** Exact private binding consumer. Only this command's protected allocation
 * receipt plus freshly authenticated matching metadata authorizes dispatch. */
async function privateControl(config, action, operationId, inventory) {
  if (!inventory || inventory.principal !== config.vars.NATIVE_QUALIFICATION_CONTROL_PRINCIPAL) throw unavailable("PROVIDER_CONTROL_PRINCIPAL_MISMATCH");
  const secret = process.env.INTERNAL_RUNTIME_EVENT_SECRET;
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw unavailable("FRESH_QUALIFICATION_SECRET_UNAVAILABLE");
  const stateFile = openPrivateState(operationId, action === "reserve");
  let proxy;
  let callerPath;
  let callerCreated = false;
  let pendingTimer;
  try {
    const targetAuthority = hash(JSON.stringify(canonical({ worker: config.name, account: config.account_id, props: qualificationControlProps(config), image: config.containers[0].image, helper: config.vars.NATIVE_QUALIFICATION_HELPER_SHA256, policy: config.vars.NATIVE_QUALIFICATION_POLICY_SHA256 })));
    const state = action === "reserve" ? { operationId, targetAuthority, phase: "unknown", pendingAction: "reserve" } : readState(stateFile.fd);
    if (state.operationId !== operationId || state.targetAuthority !== targetAuthority || (action !== "status" && action !== "reserve" && state.pendingAction !== undefined) || (action === "provision" && state.phase !== "reserved") || (action === "retire" && (state.phase !== "provisioned" || state.originalTransportSettled !== true))) throw unavailable("ORIGINAL_RETAINED_NO_AUTOMATIC_RERUN");
    saveState(stateFile.fd, { ...state, pendingAction: action === "status" ? state.pendingAction : action });
    callerPath = resolve(privateDirectory, `${operationId}.caller.json`);
    writeFileSync(callerPath, JSON.stringify({ name: `${config.name}-operator`, account_id: config.account_id, compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags, workers_dev: false, preview_urls: false, services: [{ binding: "NATIVE_QUALIFICATION_CONTROL", service: config.name, entrypoint: "NativeBoundaryQualificationControl", remote: true, props: qualificationControlProps(config) }] }), { flag: "wx", mode: 0o600 });
    callerCreated = true;
    const sdkLog = nullLogSink();
    process.env.WRANGLER_LOG_PATH = sdkLog.path;
    process.env.WRANGLER_LOG_SANITIZE = "true";
    // Wrangler may still have queued asynchronous log writes after dispose.
    // Keep the null sink until this operator process actually exits.
    process.once("exit", () => { try { sdkLog.close(); } catch { process.exitCode = 1; } });
    const { getPlatformProxy } = require("wrangler");
    proxy = await getPlatformProxy({ configPath: callerPath, envFiles: [], persist: false, remoteBindings: true });
    const binding = proxy.env.NATIVE_QUALIFICATION_CONTROL;
    if (binding === null || typeof binding?.fetch !== "function") throw unavailable("PRIVATE_SERVICE_BINDING_UNAVAILABLE");
    const headers = { "Content-Type": "application/json", "X-Internal-Runtime-Secret": secret };
    if (state.bearer !== undefined) headers.Authorization = `Bearer ${state.bearer}`;
    // A scenario deadline reports pending work. It does not abort the original
    // transport, rerun provisioning, retire the grant, or invent cleanup proof.
    pendingTimer = setTimeout(() => console.error("Qualification original is still pending; its grant and cleanup obligation remain retained."), 10 * 60_000);
    pendingTimer.unref();
    const response = await binding.fetch(new Request(`https://native-qualification.invalid/internal/native-boundary-qualification/v1/${action}`, { method: "POST", headers, body: JSON.stringify({ operationId, scenario: "resource_provision" }) }));
    if (!response.ok) { await response.arrayBuffer(); throw unavailable("PRIVATE_CONTROL_ORIGINAL_UNKNOWN"); }
    const reply = validateReply(await response.json(), config, operationId, action);
    saveState(stateFile.fd, { ...state, operationId, phase: reply.phase, pendingAction: action === "status" ? state.pendingAction : undefined, originalTransportSettled: reply.originalTransportSettled, bearer: reply.bearer ?? state.bearer, authorityDigest: reply.authorityDigest });
    console.log(JSON.stringify({ phase: reply.phase, active: reply.active, originalTransportSettled: reply.originalTransportSettled, runtimeQualified: false }));
  } finally {
    if (pendingTimer) clearTimeout(pendingTimer);
    // Disposal never follows a scenario timer. Transport failure retains the
    // pending state and the server's original obligation; it proves no cleanup.
    if (proxy) await proxy.dispose();
    if (callerCreated) unlinkSync(callerPath);
    closeState(stateFile);
  }
}

/** Compile and verify the exact candidate before credentials or provider
 * resources are involved. This deliberately has no target, bindings, image,
 * variables or deployment operation and grants no runtime authority. */
async function buildSource() {
  const platform = readJsonc(resolve(app, "wrangler.dev.jsonc"));
  const config = {
    name: "legioncode-native-boundary-source",
    compatibility_date: platform.compatibility_date,
    compatibility_flags: platform.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: false },
  };
  const identity = cliIdentity();
  const snapshot = configSnapshot(config);
  try {
    const source = await buildPinned(config, snapshot.path, identity, () => {});
    verifySource(source, identity);
    const receipt = resolve(source.directory, "..");
    const path = resolve(receipt, `${basename(source.directory)}.source.json`);
    const fd = openSync(path, constants.O_NOFOLLOW | constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, JSON.stringify(source)); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(receipt, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    console.log(JSON.stringify({ phase: "source-built", sourceReceipt: path, sourceSha256: hash(JSON.stringify(canonical(source))), inputCount: source.graph.length, runtimeQualified: false }));
  } finally { snapshot.close(); }
}

async function main() {
  const [action, configArgument, operationId, ...extra] = process.argv.slice(2);
  if (action === "build-source") {
    if (configArgument !== undefined || operationId !== undefined || extra.length) throw unavailable("ARGUMENTS_INVALID");
    return await buildSource();
  }
  const inspection = action === "inspect" || action === "inspect-sealed";
  if (extra.length || !["inspect", "inspect-sealed", "deploy-sealed", "activate", "reserve", "provision", "status", "retire"].includes(action) || (!inspection && !uuid.test(operationId)) || (inspection && operationId !== undefined)) throw unavailable("ARGUMENTS_INVALID");
  const configPath = resolve(configArgument ?? qualificationConfigPath);
  const { errors, config } = validateNativeQualificationIsolation({ configPath, mode: action === "inspect-sealed" || action === "deploy-sealed" ? "sealed" : "active" });
  if (errors.length) throw unavailable("STATIC_QUALIFICATION_ISOLATION_BLOCKED");
  // The CLI never reopens the caller's mutable config after validation.
  const snapshot = configSnapshot(config);
  try {
    if (action === "deploy-sealed") return await createSealed(config, snapshot.path, operationId);
    if (action === "activate") return await activate(config, snapshot.path, operationId);
    if (inspection) {
      const inventory = await providerInventory(config, snapshot.path);
      console.log(JSON.stringify({ authenticatedMetadata: { deployment: true, version: true, container: true, namespaceBindings: true, authorId: true }, originals: inventory.originals.map(original => ({ stdoutSha256: original.stdoutSha256, stderrSha256: original.stderrSha256, exitCode: original.exitCode, signal: original.signal })), cliEntrySha256: inventory.identity.entrySha256, runtimeQualified: false }));
      return;
    }
    const inventory = await controlInventory(config, snapshot.path);
    await privateControl(config, action, operationId, inventory);
  } finally { snapshot.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "NATIVE_QUALIFICATION_UNAVAILABLE";
  console.error(`Native qualification blocked: ${code}. No readiness or cleanup is implied.`);
  process.exitCode = 1;
});
