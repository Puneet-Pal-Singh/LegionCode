import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { inspectNativeFileHelper } from "./build-file-helper.mjs";

const supportedIntentFrame = '{"v":2,"event":"intent_probe","state":"supported","intentVersion":1}\n';
const acquiredFrame = '{"v":2,"event":"lease","state":"acquired","intentVersion":1}\n';
const probeFailureReasons = new Set([
  "SIGNAL_API", "BOOT", "IDENTITY", "SIGNAL", "SCRATCH_CREATE", "SCRATCH_IDENTITY",
  "SCRATCH_UNLINK", "WRITER_OFD", "LEGACY_CONFLICT", "APPEND_LOCK", "SCRATCH_CLOSE",
].map((reason) => `LC_INTENT_PROBE_${reason}\n`));

export async function verifyBundledProcessHelper(
  executablePath,
  platform,
  architecture,
) {
  const diagnostics = await inspectNativeFileHelper(executablePath, platform, architecture);
  const probe = await readHelperReceipt(executablePath, ["--probe-writer-intent"], [], "intent-probe");
  if (!probe.equals(Buffer.from(supportedIntentFrame))) throw unavailable();
  console.info(JSON.stringify({ helper: "legioncode-process-helper", stage: "bundled-intent-probe",
    intentProbe: JSON.parse(probe.toString("utf8")) }));

  const directory = await mkdtemp(join(tmpdir(), "legioncode-package-fence-"));
  let lease, root, namespace;
  try {
    const rootPath = join(directory, "root"), namespacePath = join(directory, "namespace");
    await mkdir(rootPath, { mode: 0o700 });
    await mkdir(namespacePath, { mode: 0o700 });
    root = await open(rootPath, "r");
    namespace = await open(namespacePath, "r");
    // Actual exclusive creation, never an existing empty/legacy fence inode.
    lease = await open(join(namespacePath, "fence"), "wx+", 0o600);
    const receipt = await readHelperReceipt(executablePath, [
      "--acquire-lease-fd", "6", "--root-fd", "5", "--namespace-fd", "7", "--initialize-empty", "1",
    ], [root.fd, lease.fd, namespace.fd], "fresh-inode-acquisition");
    if (!receipt.equals(Buffer.from(acquiredFrame))) throw unavailable();
    return { ...diagnostics, protocol: "guardian-fd6-v2", intentProbe: JSON.parse(probe.toString("utf8")) };
  } finally {
    // Preserve the scratch inode/handles on uncertain cleanup rather than
    // unlinking a namespace before all original borrowed descriptors close.
    const closed = await Promise.allSettled([lease, root, namespace].filter(Boolean).map((handle) => handle.close()));
    if (closed.some((result) => result.status === "rejected")) throw unavailable();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Artifact validation only: bounded status/diagnostic bytes and the original
 * trusted helper close event. A deadline requests stop; it never settles close. */
function readHelperReceipt(executablePath, args, descriptors = [], stage) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executablePath, args, {
        env: {}, shell: false,
        stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", ...descriptors],
      });
    } catch {
      reject(unavailable());
      return;
    }
    const chunks = [], diagnosticChunks = [];
    let failed = false, stopping = false;
    const stop = () => {
      failed = true;
      if (stopping) return;
      stopping = true;
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* Await actual close below. */ }
      }
    };
    const timer = setTimeout(stop, 5_000);
    child.on("error", stop);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failed || code !== 0 || signal !== null) {
        const diagnostic = Buffer.concat(diagnosticChunks).toString("ascii");
        console.error(JSON.stringify({
          helper: "legioncode-process-helper", stage, code, signal,
          ...(probeFailureReasons.has(diagnostic) ? { diagnostic: diagnostic.trim() } : {}),
        }));
        reject(unavailable());
      }
      else resolve(Buffer.concat(chunks));
    });
    for (const [stream, limit, save] of [
      [child.stdio[4], 128, true], [child.stdout, 1024, false], [child.stderr, 1024, false],
    ]) {
      if (!(stream instanceof Readable)) { stop(); continue; }
      let size = 0;
      stream.on("error", stop);
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) stop();
        else if (save) chunks.push(chunk);
        else if (stream === child.stderr) diagnosticChunks.push(chunk);
      });
    }
  });
}

function unavailable() {
  return new Error("Bundled native writer intent ABI verification failed");
}
