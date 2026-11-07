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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const minimumMacOSVersion = "12.0";
export const nativeHelperSources = [
  "legioncode-fs-helper",
  "legioncode-process-helper",
].map((name) => ({
  name,
  sourcePath: fileURLToPath(
    new URL(
      `../../../packages/execution-engine/src/runtime/desktop/native/${name}.c`,
      import.meta.url,
    ),
  ),
}));
const compilerEnvironment = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
};
const execute = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

function compilerArguments(platform, architecture) {
  const args = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror"];
  if (platform === "darwin")
    args.push(
      "-arch",
      architecture === "x64" ? "x86_64" : "arm64",
      `-mmacosx-version-min=${minimumMacOSVersion}`,
    );
  return args;
}

function dependencyPaths(output) {
  // -MT fixes the target; consume Make's escaped paths/line continuations,
  // including source directories containing spaces, without invoking a shell.
  if (!output.startsWith("native-helper:"))
    throw new Error("Invalid native source dependency receipt");
  const paths = [];
  let path = "",
    escaped = false;
  for (const character of output.slice("native-helper:".length)) {
    if (escaped) {
      if (character !== "\n") path += character;
      escaped = false;
    } else if (character === "\\") escaped = true;
    else if (/\s/u.test(character)) {
      if (path) paths.push(path);
      path = "";
    } else path += character;
  }
  if (escaped) throw new Error("Invalid native source dependency escape");
  if (path) paths.push(path);
  if (!paths.length || paths.length > 64)
    throw new Error("Native source dependencies exceed their bound");
  return paths;
}

/** Hash the compiler's actual local C/header unit, not just its entry C file.
 * System SDK headers remain compiler/toolchain provenance; no source bytes log.
 */
export async function hashNativeHelperCompilationUnit(
  sourcePath,
  platform,
  architecture,
) {
  assertNativeFileHelperTarget(platform, architecture);
  const source = await realpath(sourcePath),
    directory = dirname(source);
  try {
    const { stdout } = await execute(
      platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc",
      [
        ...compilerArguments(platform, architecture),
        "-MM",
        "-MT",
        "native-helper",
        source,
      ],
      { env: compilerEnvironment, timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    const files = new Map();
    let total = 0;
    for (const path of dependencyPaths(stdout)) {
      const canonical = await realpath(resolve(path)),
        name = relative(directory, canonical);
      if (
        !name ||
        isAbsolute(name) ||
        name === ".." ||
        name.startsWith(`..${sep}`) ||
        !/\.[ch]$/u.test(name)
      )
        throw new Error("Native dependency is outside its source unit");
      const bytes = await readFile(canonical);
      if ((total += bytes.length) > 1024 * 1024)
        throw new Error("Native source unit exceeds its byte bound");
      files.set(name, bytes);
    }
    if (!files.has(basename(source)))
      throw new Error("Native compiler omitted its entry source");
    const hash = createHash("sha256");
    for (const [name, bytes] of [...files].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      hash.update(JSON.stringify([name, bytes.length]));
      hash.update("\n");
      hash.update(bytes);
    }
    return hash.digest("hex");
  } catch {
    throw new Error("Native helper compilation-unit provenance failed");
  }
}

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
  let macOSMinimum;
  if (platform === "darwin" && bytes.length >= 32) {
    matches =
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) ===
        (architecture === "arm64" ? 0x0100000c : 0x01000007);
    if (matches) macOSMinimum = inspectMacOSMinimum(bytes);
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
    ...(macOSMinimum ? { minimumMacOSVersion: macOSMinimum } : {}),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function encodedMacOSVersion(version) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version))
    throw new Error("Native helper macOS minimum is invalid");
  const [major, minor, patch = 0] = version.split(".").map(Number);
  if (major > 65535 || minor > 255 || patch > 255)
    throw new Error("Native helper macOS minimum is invalid");
  return major * 65536 + minor * 256 + patch;
}

function inspectMacOSMinimum(bytes) {
  const commands = bytes.readUInt32LE(16);
  const end = 32 + bytes.readUInt32LE(20);
  if (end > bytes.length || commands > (end - 32) / 8)
    throw new Error("Native helper Mach-O load commands are invalid");
  let offset = 32;
  let minimum;
  for (let index = 0; index < commands; index++) {
    if (offset + 8 > end)
      throw new Error("Native helper Mach-O load commands are invalid");
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 !== 0 || offset + size > end)
      throw new Error("Native helper Mach-O load commands are invalid");
    if (command === 0x32 || command === 0x24) {
      if (
        size < (command === 0x32 ? 24 : 16) ||
        minimum !== undefined ||
        (command === 0x32 && bytes.readUInt32LE(offset + 8) !== 1)
      ) {
        throw new Error("Native helper Mach-O deployment target is invalid");
      }
      minimum = bytes.readUInt32LE(offset + (command === 0x32 ? 12 : 8));
    }
    offset += size;
  }
  if (
    offset !== end ||
    minimum === undefined ||
    minimum === 0 ||
    minimum > encodedMacOSVersion(minimumMacOSVersion)
  ) {
    throw new Error(
      "Native helper requires a newer macOS version than the app advertises",
    );
  }
  return `${minimum >>> 16}.${(minimum >>> 8) & 255}.${minimum & 255}`;
}

export async function verifyPackagedMacOSMinimum(infoPlistPath) {
  const { stdout } = await execute(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :LSMinimumSystemVersion", infoPlistPath],
    {
      env: compilerEnvironment,
      timeout: 5_000,
      maxBuffer: 256,
    },
  );
  if (
    encodedMacOSVersion(stdout.trim()) !==
    encodedMacOSVersion(minimumMacOSVersion)
  ) {
    throw new Error(
      "Packaged app macOS minimum does not match native helper configuration",
    );
  }
}

export async function buildNativeFileHelper(
  sourcePath,
  platform,
  architecture,
  helperName,
) {
  assertNativeFileHelperTarget(platform, architecture);
  if (!nativeHelperSources.some(({ name }) => name === helperName)) {
    throw new Error("Unsupported native helper build target");
  }
  const source = await realpath(sourcePath);
  const sourceSha256 = await hashNativeHelperCompilationUnit(
    source,
    platform,
    architecture,
  );
  const outputDirectory = join(projectDirectory, "native-bin");
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    join(outputDirectory, ".file-helper-"),
  );
  const temporaryExecutable = join(temporaryDirectory, helperName);
  try {
    const compiler = platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc";
    const args = compilerArguments(platform, architecture);
    args.push(source, "-o", temporaryExecutable);
    try {
      await execute(compiler, args, {
        env: compilerEnvironment,
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      // Compiler errors can contain source paths and source text. Keep CI output bounded and private.
      throw new Error("Native file helper compilation failed");
    }
    const diagnostics = await inspectNativeFileHelper(
      temporaryExecutable,
      platform,
      architecture,
    );
    if (
      sourceSha256 !==
      (await hashNativeHelperCompilationUnit(source, platform, architecture))
    )
      throw new Error("Native source unit changed during compilation");
    await chmod(temporaryExecutable, 0o755);
    await rename(temporaryExecutable, join(outputDirectory, helperName));
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
    for (const { name, sourcePath } of nativeHelperSources) {
      const diagnostics = await buildNativeFileHelper(
        sourcePath,
        process.platform,
        process.arch,
        name,
      );
      console.log(JSON.stringify({ helper: name, ...diagnostics }));
    }
  } catch {
    console.error("Native helper build failed");
    process.exitCode = 1;
  }
}
