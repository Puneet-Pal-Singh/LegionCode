import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  open,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

export function assertNativeFileHelperTarget(platform, architecture) {
  if (
    !["darwin", "linux"].includes(platform) ||
    !["arm64", "x64"].includes(architecture) ||
    platform !== process.platform ||
    architecture !== process.arch
  ) {
    throw new Error(
      "Native file helper requires the current supported platform and architecture",
    );
  }
}

export async function inspectNativeFileHelper(path, platform, architecture) {
  assertNativeFileHelperTarget(platform, architecture);
  const bytes = await readFile(path);
  let matches = false;
  if (platform === "darwin" && bytes.length >= 8) {
    matches =
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) ===
        (architecture === "arm64" ? 0x0100000c : 0x01000007);
  } else if (platform === "linux" && bytes.length >= 20) {
    matches =
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(18) === (architecture === "arm64" ? 183 : 62);
  }
  if (!matches)
    throw new Error("Native file helper executable architecture is invalid");
  return {
    platform,
    architecture,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function buildNativeFileHelper(
  sourcePath,
  platform,
  architecture,
) {
  assertNativeFileHelperTarget(platform, architecture);
  const source = await realpath(sourcePath);
  const sourceSha256 = createHash("sha256")
    .update(await readFile(source))
    .digest("hex");
  const outputDirectory = join(projectDirectory, "native-bin");
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    join(outputDirectory, ".file-helper-"),
  );
  const temporaryExecutable = join(temporaryDirectory, "legioncode-fs-helper");
  try {
    const compiler = platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc";
    const args = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror"];
    if (platform === "darwin")
      args.push("-arch", architecture === "x64" ? "x86_64" : "arm64");
    args.push(source, "-o", temporaryExecutable);
    try {
      await execute(compiler, args, { timeout: 60_000, maxBuffer: 64 * 1024 });
    } catch {
      // Compiler errors can contain source paths and source text. Keep CI output bounded and private.
      throw new Error("Native file helper compilation failed");
    }
    const diagnostics = await inspectNativeFileHelper(
      temporaryExecutable,
      platform,
      architecture,
    );
    await chmod(temporaryExecutable, 0o755);
    await rename(
      temporaryExecutable,
      join(outputDirectory, "legioncode-fs-helper"),
    );
    return { ...diagnostics, sourceSha256 };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function verifyBundledFileHelper(
  executablePath,
  platform,
  architecture,
) {
  const diagnostics = await inspectNativeFileHelper(
    executablePath,
    platform,
    architecture,
  );
  const expected = await readFile(executablePath);
  if (expected.length > 4 * 1024 * 1024)
    throw new Error("Native filesystem helper exceeds its read protocol limit");
  const directory = await open(dirname(executablePath), "r");
  try {
    const path = Buffer.from(basename(executablePath), "utf8");
    const request = Buffer.alloc(10 + path.length);
    request.set([76, 67, 70, 77, 1, 82]);
    request.writeUInt32BE(path.length, 6);
    path.copy(request, 10);
    const receipt = await new Promise((resolve, reject) => {
      const child = spawn(executablePath, [], {
        env: {},
        shell: false,
        stdio: ["pipe", "pipe", "pipe", directory.fd],
      });
      const chunks = [];
      let size = 0;
      let failed = false;
      const stop = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, 5_000);
      child.once("error", stop);
      child.stdin.on("error", stop);
      child.stdout.on("error", stop);
      child.stderr.on("error", stop);
      child.stderr.resume();
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > expected.length + 6) {
          stop();
          return;
        }
        chunks.push(chunk);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (failed || code !== 0 || signal !== null) {
          reject(
            new Error("Bundled native filesystem helper invocation failed"),
          );
        } else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(request);
    });
    if (
      receipt.length !== expected.length + 6 ||
      receipt[0] !== 73 ||
      receipt[1] !== 1 ||
      receipt.readUInt32BE(2) !== expected.length ||
      !receipt.subarray(6).equals(expected)
    ) {
      throw new Error(
        "Bundled native filesystem helper returned an invalid LCFM/1 receipt",
      );
    }
    return { ...diagnostics, protocol: "LCFM/1" };
  } finally {
    await directory.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const source = fileURLToPath(
      new URL(
        "../../../packages/execution-engine/src/runtime/desktop/native/legioncode-fs-helper.c",
        import.meta.url,
      ),
    );
    const diagnostics = await buildNativeFileHelper(
      source,
      process.platform,
      process.arch,
    );
    console.log(
      JSON.stringify({ helper: "legioncode-fs-helper", ...diagnostics }),
    );
  } catch {
    console.error("Native filesystem helper build failed");
    process.exitCode = 1;
  }
}
