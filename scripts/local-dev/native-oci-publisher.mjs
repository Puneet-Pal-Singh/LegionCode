import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { devNull } from "node:os";

const origin = "https://registry.cloudflare.com";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const maxImageBytes = 1_350_000_000;
const maxArchiveBytes = 1_600_000_000;
const files = ["SHA256SUMS", "checked-docker-config.json", "docker-inspect.json", "expected-oci-config.json", "image.oci.tar", "legioncode-command-supervisor", "sbom.spdx.json", "source-receipt.json"];
const sourcePaths = ["apps/secure-agent-api/Dockerfile", "apps/secure-agent-api/container-native", "apps/secure-agent-api/container-tools", "apps/secure-agent-api/container-requirements.txt", "scripts/gates/check-secure-container-image.mjs", ".github/workflows/native-container-package.yml"];
const verified = new WeakMap();
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fail = code => { throw new Error(code); };
const assert = (condition, code = "OCI_PACKAGE_INVALID") => { if (!condition) fail(code); };
const json = bytes => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("OCI_JSON_INVALID"); } };

function pinnedFile(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit), "OCI_FILE_TYPE_OR_SIZE_INVALID");
    const check = () => {
      const after = fstatSync(fd, { bigint: true });
      const current = lstatSync(path, { bigint: true });
      for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"]) assert(after[key] === before[key] && current[key] === before[key], "OCI_FILE_CHANGED");
      assert(current.isFile() && !current.isSymbolicLink(), "OCI_FILE_CHANGED");
    };
    return { fd, size: Number(before.size), check, close: () => closeSync(fd) };
  } catch (error) { closeSync(fd); throw error; }
}
function read(file, offset, size) {
  assert(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && offset + size <= file.size);
  const bytes = Buffer.alloc(size);
  let count = 0;
  while (count < size) { const next = readSync(file.fd, bytes, count, size - count, offset + count); assert(next > 0); count += next; }
  return bytes;
}
function rangeStream(file, entry) {
  return Readable.from((async function* () {
    for (let count = 0; count < entry.size; count += 1024 * 1024) yield read(file, entry.offset + count, Math.min(1024 * 1024, entry.size - count));
    file.check();
  })());
}
function hashRange(file, offset = 0, size = file.size) {
  const checksum = createHash("sha256");
  for (let count = 0; count < size; count += 1024 * 1024) checksum.update(read(file, offset + count, Math.min(1024 * 1024, size - count)));
  file.check();
  return checksum.digest("hex");
}
function tarEntries(file) {
  const entries = new Map();
  let offset = 0;
  let ended = false;
  const string = bytes => { const end = bytes.indexOf(0); return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end)); };
  const octal = bytes => { const value = string(bytes).trim(); assert(/^[0-7]+$/.test(value)); const number = parseInt(value, 8); assert(Number.isSafeInteger(number)); return number; };
  while (offset + 512 <= file.size) {
    const header = read(file, offset, 512);
    if (header.every(byte => byte === 0)) { assert(offset + 1024 <= file.size); ended = true; break; }
    const expected = octal(header.subarray(148, 156));
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    assert(checksum === expected, "OCI_TAR_CHECKSUM_INVALID");
    assert(["ustar", "ustar "].includes(string(header.subarray(257, 263))), "OCI_TAR_FORMAT_UNSUPPORTED");
    const name = `${string(header.subarray(345, 500)) ? string(header.subarray(345, 500)) + "/" : ""}${string(header.subarray(0, 100))}`;
    const normalized = name.startsWith("./") ? name.slice(2) : name;
    const size = octal(header.subarray(124, 136));
    const type = header[156];
    assert(string(header.subarray(157, 257)) === "" && !entries.has(normalized), "OCI_TAR_LINK_OR_DUPLICATE");
    assert(type === 53 ? size === 0 && ["", "blobs/", "blobs/sha256/"].includes(normalized) :
      (type === 0 || type === 48) && /^(?:index\.json|oci-layout|blobs\/sha256\/[a-f0-9]{64})$/.test(normalized), "OCI_TAR_ENTRY_UNSUPPORTED");
    assert(offset + 512 + size <= file.size);
    assert(entries.size < 260, "OCI_TAR_ENTRY_LIMIT");
    entries.set(normalized, { offset: offset + 512, size, directory: type === 53 });
    const padding = Math.ceil(size / 512) * 512 - size;
    assert(read(file, offset + 512 + size, padding).every(byte => byte === 0), "OCI_TAR_PADDING_INVALID");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(ended, "OCI_TAR_NOT_CLOSED");
  for (; offset < file.size; offset += 1024 * 1024) assert(read(file, offset, Math.min(1024 * 1024, file.size - offset)).every(byte => byte === 0), "OCI_TAR_TRAILING_DATA");
  return entries;
}

/** Verification performs no provider operation and executes no packaged content.
 * All held file identities remain pinned until close(), including during upload. */
export async function verifyNativeOciPackage({ packageDirectory, repositoryRoot, expectedSourceCommit }) {
  assert(commit.test(expectedSourceCommit), "OCI_REVIEWED_SOURCE_REQUIRED");
  const directory = resolve(packageDirectory);
  assert(realpathSync(directory) === directory && same(readdirSync(directory).sort(), files), "OCI_PACKAGE_CLOSURE_INVALID");
  const held = new Map();
  try {
    for (const name of files) held.set(name, pinnedFile(resolve(directory, name), name === "image.oci.tar" ? maxArchiveBytes : name === "sbom.spdx.json" ? 64 * 1024 * 1024 : 16 * 1024 * 1024));
    const bytes = name => read(held.get(name), 0, held.get(name).size);
    const sums = new TextDecoder("utf-8", { fatal: true }).decode(bytes("SHA256SUMS"));
    const expectedNames = files.filter(name => name !== "SHA256SUMS");
    const lines = sums.split("\n");
    assert(lines.pop() === "" && lines.length === expectedNames.length, "OCI_CHECKSUM_CLOSURE_INVALID");
    for (let index = 0; index < lines.length; index++) {
      const match = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(lines[index]);
      assert(match && match[2] === expectedNames[index] && hashRange(held.get(match[2])) === match[1], "OCI_PACKAGE_CHECKSUM_MISMATCH");
    }
    const receiptBytes = bytes("source-receipt.json");
    const receipt = json(receiptBytes);
    assert(receipt.version === 1 && receipt.sourceCommit === expectedSourceCommit && receipt.platform === "linux/amd64" && receipt.configurationConversion === "docker-v2s2-to-oci-v1" && receipt.published === false && receipt.runtimeQualified === false);
    assert(/^[1-9][0-9]*$/.test(receipt.workflowRunId) && /^[1-9][0-9]*$/.test(receipt.workflowRunAttempt));
    for (const key of ["checkedImageId", "imageDigest", "ociConfigDigest"]) assert(digestPattern.test(receipt[key]));
    for (const key of ["helperSha256", "policySourceSha256", "sbomSha256", "checkedConfigSha256"]) assert(sha.test(receipt[key]));
    const git = args => execFileSync("git", ["-C", repositoryRoot, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_PAGER: "cat" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    assert(git(["rev-parse", "--verify", `${expectedSourceCommit}^{commit}`]).toString().trim() === expectedSourceCommit);
    // GitHub pull_request packages can be built on a synthetic merge commit.
    // Require that exact reviewed commit or one of its parents in our ancestry,
    // plus byte-identical complete image input graphs at source and current HEAD.
    const ancestry = git(["rev-list", "--parents", "-n", "1", expectedSourceCommit]).toString().trim().split(" ");
    assert(ancestry.some(value => { try { git(["merge-base", "--is-ancestor", value, "HEAD"]); return true; } catch { return false; } }), "OCI_SOURCE_ANCESTRY_UNCONFIRMED");
    const paths = git(["ls-tree", "-r", "--name-only", expectedSourceCommit, "--", ...sourcePaths]).toString().trim().split("\n").sort();
    const currentPaths = git(["ls-tree", "-r", "--name-only", "HEAD", "--", ...sourcePaths]).toString().trim().split("\n").sort();
    assert(paths.length > 0 && same(paths, currentPaths) && Array.isArray(receipt.inputs) && receipt.inputs.length === paths.length, "OCI_SOURCE_CLOSURE_INVALID");
    for (let index = 0; index < paths.length; index++) {
      const input = receipt.inputs[index];
      assert(same(Object.keys(input).sort(), ["path", "sha256"]) && input.path === paths[index] && sha.test(input.sha256));
      for (const ref of [expectedSourceCommit, "HEAD"]) assert(hash(git(["show", `${ref}:${input.path}`])) === input.sha256, "OCI_SOURCE_BLOB_MISMATCH");
    }
    const policy = receipt.inputs.filter(input => input.path.includes("/container-native/"));
    assert(policy.length > 0 && hash(JSON.stringify(canonical(policy))) === receipt.policySourceSha256, "OCI_POLICY_MISMATCH");
    const helper = bytes("legioncode-command-supervisor");
    assert(hash(helper) === receipt.helperSha256 && helper.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) && helper.readUInt16LE(18) === 62, "OCI_HELPER_MISMATCH");
    const sbom = bytes("sbom.spdx.json");
    const sbomValue = json(sbom);
    assert(hash(sbom) === receipt.sbomSha256 && /^SPDX-/.test(sbomValue.spdxVersion) && Array.isArray(sbomValue.packages) && sbomValue.packages.length > 0, "OCI_SBOM_MISMATCH");
    const archive = held.get("image.oci.tar");
    const entries = tarEntries(archive);
    const used = new Set(["index.json", "oci-layout"]);
    const entryBytes = name => { const entry = entries.get(name); assert(entry && !entry.directory && entry.size <= 16 * 1024 * 1024); return read(archive, entry.offset, entry.size); };
    assert(same(json(entryBytes("oci-layout")), { imageLayoutVersion: "1.0.0" }));
    const index = json(entryBytes("index.json"));
    assert(index.schemaVersion === 2 && Array.isArray(index.manifests) && index.manifests.length === 1);
    const descriptor = index.manifests[0];
    const blob = descriptor => {
      assert(digestPattern.test(descriptor.digest) && Number.isSafeInteger(descriptor.size) && descriptor.size > 0);
      const name = `blobs/sha256/${descriptor.digest.slice(7)}`;
      const entry = entries.get(name);
      assert(entry && !entry.directory && entry.size === descriptor.size && hashRange(archive, entry.offset, entry.size) === descriptor.digest.slice(7), "OCI_BLOB_MISMATCH");
      used.add(name);
      return { ...entry, digest: descriptor.digest };
    };
    const manifestEntry = blob(descriptor);
    assert(manifestEntry.digest === receipt.imageDigest && descriptor.mediaType === "application/vnd.oci.image.manifest.v1+json");
    const manifestBytes = entryBytes(`blobs/sha256/${descriptor.digest.slice(7)}`);
    const manifest = json(manifestBytes);
    assert(manifest.schemaVersion === 2 && manifest.mediaType === descriptor.mediaType && Array.isArray(manifest.layers) && manifest.layers.length > 0 && manifest.layers.length <= 128 && manifest.subject === undefined);
    const configEntry = blob(manifest.config);
    assert(manifest.config.mediaType === "application/vnd.oci.image.config.v1+json" && configEntry.digest === receipt.ociConfigDigest);
    const config = json(entryBytes(`blobs/sha256/${configEntry.digest.slice(7)}`));
    const checkedBytes = bytes("checked-docker-config.json");
    const checked = json(checkedBytes);
    assert(`sha256:${hash(checkedBytes)}` === receipt.checkedImageId && hash(checkedBytes) === receipt.checkedConfigSha256);
    assert(same(config, json(bytes("expected-oci-config.json"))) && config.architecture === "amd64" && config.os === "linux" && config.architecture === checked.architecture && config.os === checked.os && same(config.rootfs, checked.rootfs) && config.rootfs?.type === "layers" && Array.isArray(config.rootfs.diff_ids) && config.rootfs.diff_ids.length === manifest.layers.length, "OCI_CONFIG_MISMATCH");
    const defaults = { User: "", ExposedPorts: {}, Env: [], Entrypoint: [], Cmd: [], Volumes: {}, WorkingDir: "", Labels: {}, StopSignal: "", ArgsEscaped: false };
    const legacy = { Hostname: "", Domainname: "", AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, OpenStdin: false, StdinOnce: false, Image: "", NetworkDisabled: false, MacAddress: "", Healthcheck: {}, OnBuild: [], Shell: [] };
    for (const [key, fallback] of Object.entries(defaults)) assert(same(checked.config?.[key] ?? fallback, config.config?.[key] ?? fallback), "OCI_RUNTIME_DEFAULT_MISMATCH");
    for (const [key, value] of Object.entries(checked.config ?? {})) if (!Object.hasOwn(defaults, key)) assert(Object.hasOwn(legacy, key) && (value === null || same(value, legacy[key])), "OCI_DOCKER_ONLY_CONFIG_UNSUPPORTED");
    const inspected = json(bytes("docker-inspect.json"));
    assert(Array.isArray(inspected) && inspected.length === 1 && inspected[0].Id === receipt.checkedImageId && inspected[0].Size === receipt.imageBytes && Number.isSafeInteger(receipt.imageBytes) && receipt.imageBytes > 0 && receipt.imageBytes <= maxImageBytes);
    const blobs = [configEntry];
    let uncompressedTotal = 0;
    for (let index = 0; index < manifest.layers.length; index++) {
      const layer = manifest.layers[index];
      const entry = blob(layer);
      assert(["application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip"].includes(layer.mediaType) && digestPattern.test(config.rootfs.diff_ids[index]));
      const source = rangeStream(archive, entry);
      const stream = layer.mediaType.endsWith("+gzip") ? source.pipe(createGunzip()) : source;
      source.on("error", error => stream.destroy(error));
      const checksum = createHash("sha256");
      try {
        for await (const chunk of stream) { uncompressedTotal += chunk.length; assert(uncompressedTotal <= maxImageBytes, "OCI_LAYER_EXPANSION_LIMIT"); checksum.update(chunk); }
      } finally { stream.destroy(); source.destroy(); }
      assert(`sha256:${checksum.digest("hex")}` === config.rootfs.diff_ids[index], "OCI_LAYER_DIFFID_MISMATCH");
      blobs.push(entry);
    }
    assert([...entries].every(([name, entry]) => entry.directory || used.has(name)), "OCI_BLOB_CLOSURE_INVALID");
    const check = () => { assert(realpathSync(directory) === directory && same(readdirSync(directory).sort(), files), "OCI_PACKAGE_CHANGED"); for (const file of held.values()) file.check(); };
    check();
    const summary = Object.freeze({ sourceCommit: receipt.sourceCommit, sourceReceiptSha256: hash(receiptBytes), archiveSha256: hashRange(archive), imageDigest: receipt.imageDigest, helperSha256: receipt.helperSha256, policySourceSha256: receipt.policySourceSha256, workflowRunId: receipt.workflowRunId, workflowRunAttempt: receipt.workflowRunAttempt });
    const result = Object.freeze({ ...summary, close() { const state = verified.get(result); if (state) { verified.delete(result); for (const file of held.values()) file.close(); } } });
    verified.set(result, { archive, blobs, manifestBytes, check, summary });
    return result;
  } catch (error) { for (const file of held.values()) file.close(); throw error; }
}

/** One original publication only. The caller's existing protected journal must
 * retain every pending mutation on failure; this helper never retries or adopts. */
export async function publishNativeOciImage({ verifiedPackage, accountId, repository, tag, acquireCredential, recordIntent, readIntent }) {
  const state = verified.get(verifiedPackage);
  assert(state, "OCI_VERIFIED_PACKAGE_REQUIRED");
  assert(/^[a-f0-9]{32}$/.test(accountId) && /^legioncode-nq-[a-f0-9]{32}$/.test(repository), "OCI_TARGET_INVALID");
  assert(new RegExp(`^source-${verifiedPackage.sourceCommit}-[a-f0-9]{32}$`).test(tag), "OCI_TAG_INVALID");
  assert(readIntent().phase === "prepared" && readIntent().pendingAction === undefined, "OCI_ORIGINAL_RETAINED_NO_RETRY");
  state.check();
  const base = `${origin}/v2/${accountId}/${repository}`;
  const target = `${origin.slice(8)}/${accountId}/${repository}`;
  let credential;
  let authorization;
  const url = (path, baseUrl = origin) => {
    const value = new URL(path, baseUrl);
    assert(value.origin === origin && value.username === "" && value.password === "" && value.hash === "" && value.pathname.startsWith(`/v2/${accountId}/${repository}/`), "OCI_UPLOAD_LOCATION_OUTSIDE_TARGET");
    return value;
  };
  const body = async (response, max) => {
    if (!response.body) return Buffer.alloc(0);
    const size = response.headers.get("content-length");
    assert(size === null || /^(0|[1-9][0-9]*)$/.test(size) && Number(size) <= max, "OCI_RESPONSE_LIMIT");
    const chunks = [];
    let total = 0;
    if (response.body) { const reader = response.body.getReader(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.length; assert(total <= max, "OCI_RESPONSE_LIMIT"); chunks.push(value); } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
    return Buffer.concat(chunks, total);
  };
  const request = async (method, location, payload, headers = {}, mutation) => {
    state.check();
    const destination = url(location);
    if (mutation) { assert(readIntent().pendingAction === undefined, "OCI_ORIGINAL_RETAINED_NO_RETRY"); recordIntent({ phase: "publishing", pendingAction: mutation }); }
    let response;
    try { response = await fetch(destination, { method, headers: { Authorization: authorization, ...headers }, redirect: "manual", body: payload, ...(payload && typeof payload !== "string" && !Buffer.isBuffer(payload) ? { duplex: "half" } : {}), signal: AbortSignal.timeout(15 * 60_000) }); }
    catch { fail("OCI_REGISTRY_ORIGINAL_UNKNOWN"); }
    // Never follow redirects, including redirects to another path on this host.
    if (response.status >= 300 && response.status < 400) { await body(response, 64 * 1024); fail("OCI_REGISTRY_REDIRECT_FORBIDDEN"); }
    return response;
  };
  const acknowledged = () => recordIntent({ phase: "publishing", pendingAction: undefined });
  try {
    credential = await acquireCredential();
    assert(Buffer.isBuffer(credential) && credential.length >= 1 && credential.length <= 16384 && !credential.some(byte => byte < 33 || byte > 126), "OCI_TEMPORARY_CREDENTIAL_INVALID");
    const basicBytes = Buffer.concat([Buffer.from("v1:"), credential]);
    try { authorization = `Basic ${basicBytes.toString("base64")}`; }
    finally { basicBytes.fill(0); }
    const tagUrl = `${base}/manifests/${tag}`;
    const absent = await request("HEAD", tagUrl);
    await body(absent, 64 * 1024);
    assert(absent.status === 404, "OCI_TARGET_TAG_NOT_PROVEN_ABSENT");
    for (const entry of state.blobs) {
      const existing = await request("HEAD", `${base}/blobs/${entry.digest}`);
      await body(existing, 64 * 1024);
      if (existing.status === 200) { assert(existing.headers.get("docker-content-digest") === entry.digest && Number(existing.headers.get("content-length")) === entry.size, "OCI_REMOTE_BLOB_MISMATCH"); continue; }
      assert(existing.status === 404, "OCI_REMOTE_BLOB_STATUS_UNKNOWN");
      const started = await request("POST", `${base}/blobs/uploads/`, undefined, { "Content-Length": "0" }, { method: "POST", blobDigest: entry.digest });
      await body(started, 64 * 1024);
      assert(started.status === 202, "OCI_BLOB_UPLOAD_ORIGINAL_UNKNOWN");
      const upload = url(started.headers.get("location") ?? "", `${base}/blobs/uploads/`);
      assert(new RegExp(`^/v2/${accountId}/${repository}/blobs/uploads/[A-Za-z0-9._~-]+/?$`).test(upload.pathname) && upload.search.length <= 16384 && [...upload.searchParams.keys()].every(key => key === "_state"), "OCI_UPLOAD_LOCATION_INVALID");
      acknowledged();
      upload.searchParams.set("digest", entry.digest);
      const stream = rangeStream(state.archive, entry);
      const drained = finished(stream, { cleanup: true });
      // Install a rejection handler before fetch starts consuming this stream.
      void drained.catch(() => {});
      let uploaded;
      try { uploaded = await request("PUT", upload.href, stream, { "Content-Type": "application/octet-stream", "Content-Length": String(entry.size) }, { method: "PUT", blobDigest: entry.digest }); await body(uploaded, 64 * 1024); await drained; }
      finally { stream.destroy(); }
      assert(uploaded.status === 201 && uploaded.headers.get("docker-content-digest") === entry.digest, "OCI_BLOB_UPLOAD_ORIGINAL_UNKNOWN");
      state.check();
      acknowledged();
    }
    const pushed = await request("PUT", tagUrl, state.manifestBytes, { "Content-Type": "application/vnd.oci.image.manifest.v1+json", "Content-Length": String(state.manifestBytes.length) }, { method: "PUT", manifestDigest: verifiedPackage.imageDigest });
    await body(pushed, 64 * 1024);
    assert(pushed.status === 201 && pushed.headers.get("docker-content-digest") === verifiedPackage.imageDigest, "OCI_MANIFEST_ORIGINAL_UNKNOWN");
    // Keep the manifest mutation pending until both its tag and digest return
    // the exact original bytes. A later status read cannot retire ambiguity.
    for (const reference of [tag, verifiedPackage.imageDigest]) {
      const response = await request("GET", `${base}/manifests/${reference}`, undefined, { Accept: "application/vnd.oci.image.manifest.v1+json" });
      const bytes = await body(response, state.manifestBytes.length);
      assert(response.status === 200 && response.headers.get("content-type")?.split(";")[0] === "application/vnd.oci.image.manifest.v1+json" && response.headers.get("docker-content-digest") === verifiedPackage.imageDigest && bytes.equals(state.manifestBytes), "OCI_MANIFEST_READBACK_MISMATCH");
    }
    state.check();
    const result = { ...state.summary, accountId, repository, tag, image: `${target}@${verifiedPackage.imageDigest}`, published: true, runtimeQualified: false };
    recordIntent({ phase: "published", pendingAction: undefined, receipt: result });
    return result;
  } catch { fail("OCI_PUBLICATION_ORIGINAL_UNCONFIRMED"); }
  finally { if (Buffer.isBuffer(credential)) credential.fill(0); authorization = undefined; }
}
