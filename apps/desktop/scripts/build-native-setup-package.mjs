import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectNativeFileHelper, nativeHelperSources } from "./build-file-helper.mjs";

const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
const installedApp = "/Library/Application Support/LegionCode/Applications/LegionCode Desktop.app";
const identifier = "dev.legioncode.desktop.native-setup";

/** A deadline is failure, never proof that a child or its descendants closed. */
function command(file, args, ownership, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, { env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { reject(new Error("Package tool could not start")); return; }
    let output = "", size = 0, failure = null, finished = false, stopping = false, forceTimer, closeTimer;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(closeTimer);
      error ? reject(error) : resolve(output);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      ownership.unknownClosure = true;
      failure = new Error("Package tool closure is unconfirmed; staging is retained");
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      closeTimer = setTimeout(() => finish(failure), 5_000);
    };
    const timer = setTimeout(stop, timeoutMs);
    child.on("error", () => { failure ??= new Error("Package tool failed"); });
    child.stdout.on("error", stop); child.stderr.on("error", stop);
    child.stdout.on("data", bytes => {
      size += bytes.length;
      if (size > 64 * 1024) stop(); else output += bytes.toString("utf8");
    });
    child.stderr.on("data", bytes => { size += bytes.length; if (size > 64 * 1024) stop(); });
    child.once("close", (code, signal) => finish(failure ?? (code === 0 && signal === null
      ? null : new Error("Package tool returned a failure"))));
  });
}

function beneath(root, path) {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Output package already exists");
}

async function packageDigest(path) {
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await file.close(); }
}

/** Validate links without following them for chmod; only the owned copy is hardened. */
async function inspectApp(root, protect = false) {
  let entries = 0, bytes = 0;
  async function visit(path, depth) {
    if (++entries > 100_000 || depth > 64) throw new Error("Packaged application exceeds its traversal bound");
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      if (!beneath(root, await realpath(path))) throw new Error("Application link leaves its bundle");
      return;
    }
    if ((!entry.isDirectory() && !entry.isFile()) || (entry.mode & 0o6000))
      throw new Error("Application contains an unsupported inode");
    if ((bytes += entry.isFile() ? entry.size : 0) > 4 * 1024 ** 3)
      throw new Error("Packaged application exceeds its byte bound");
    if (protect) await chmod(path, (entry.mode & 0o777) & ~0o022);
    if (entry.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name), depth + 1);
  }
  await visit(root, 0);
}

// Fixed installer scripts contain no CLI paths or user-supplied shell fragments.
const preinstall = `#!/bin/sh
set -eu
[ "\${3:-/}" = / ] || { echo 'Install on the startup volume only.' >&2; exit 1; }
case "$0" in
  */*) script_directory=\${0%/*} ;;
  *) echo 'Package script location could not be confirmed.' >&2; exit 1 ;;
esac
[ -n "$script_directory" ] || script_directory=/
# The package-contained canonical helper owns root/presence/service preflight.
exec "$script_directory/legioncode-native-installer" --preflight
`;
const postinstall = `#!/bin/sh
set -eu
[ "\${3:-/}" = / ] || exit 1
# This exact installed app helper owns staging and bounded setup child closure.
exec '/Library/Application Support/LegionCode/Applications/LegionCode Desktop.app/Contents/Resources/native/legioncode-native-installer' --stage
`;

// pkgbuild(1)'s component property list pins the only bundle in this payload.
// In particular, an older bundle discovered elsewhere must never receive it.
const components = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><dict>
<key>RootRelativeBundlePath</key><string>LegionCode Desktop.app</string>
<key>BundleIsRelocatable</key><false/>
<key>BundleHasStrictIdentifier</key><true/>
<key>BundleIsVersionChecked</key><true/>
<key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>
`;

export async function buildNativeSetupPackage(appPath, packagePath) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
    throw new Error("Native setup packages require the current supported Mac architecture");
  if (![appPath, packagePath].every(path => typeof path === "string" && isAbsolute(path) && !path.includes("\0")) ||
      !appPath.endsWith(".app") || !packagePath.endsWith(".pkg"))
    throw new Error("Supply an absolute packaged .app path and absolute output .pkg path");
  const source = await realpath(appPath);
  const sourceInfo = await lstat(appPath);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("Packaged app must be an existing directory");
  const outputDirectory = await realpath(dirname(packagePath));
  const output = join(outputDirectory, basename(packagePath));
  if (beneath(source, output)) throw new Error("Package output must be outside the source application");
  await absent(output);
  await inspectApp(source);
  const helpers = ["legioncode-host-broker", "legioncode-native-installer"].map(name => join(source, "Contents", "Resources", "native", name));
  for (const helper of helpers) {
    const info = await lstat(helper);
    if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111) || !beneath(source, await realpath(helper)))
      throw new Error("The packaged application lacks its actual contained native setup executables");
    await inspectNativeFileHelper(helper, process.platform, process.arch);
  }
  const ownership = { unknownClosure: false };
  const plist = join(source, "Contents", "Info.plist");
  const version = (await command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], ownership)).trim();
  const bundleId = (await command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], ownership)).trim();
  if (!/^[0-9]+(?:\.[0-9]+){0,3}$/u.test(version) || bundleId !== "dev.legioncode.desktop")
    throw new Error("Packaged application identity/version is invalid");
  const staging = await mkdtemp(join(outputDirectory, ".legioncode-native-setup-"));
  try {
    const scripts = join(staging, "scripts");
    const payload = join(staging, "payload");
    const stagedApp = join(payload, "LegionCode Desktop.app");
    await mkdir(scripts, { mode: 0o755 });
    await chmod(scripts, 0o755);
    await mkdir(payload, { mode: 0o755 });
    await chmod(payload, 0o755);
    await cp(source, stagedApp, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true, preserveTimestamps: true });
    await inspectApp(stagedApp, true);
    await command("/bin/chmod", ["-RN", stagedApp, scripts], ownership);
    // The preview needs no Developer ID. Seal only this owned snapshot with an
    // ad-hoc content identity so the broker can validate its exact installed code.
    // Existing unsigned previews do not enable hardened-runtime library checks.
    for (const { name } of nativeHelperSources) {
      const helper = join(stagedApp, "Contents", "Resources", "native", name);
      await inspectNativeFileHelper(helper, process.platform, process.arch);
      await command("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "0", "--timestamp=none", helper], ownership);
    }
    await command("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--options", "0",
      "--timestamp=none", "--preserve-metadata=entitlements", stagedApp], ownership, 120_000);
    await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp], ownership);
    const stagedInstaller = join(stagedApp, "Contents", "Resources", "native", "legioncode-native-installer");
    const original = await inspectNativeFileHelper(stagedInstaller, process.platform, process.arch);
    const preflightInstaller = join(scripts, "legioncode-native-installer");
    await copyFile(stagedInstaller, preflightInstaller);
    await chmod(preflightInstaller, 0o755);
    const copied = await inspectNativeFileHelper(preflightInstaller, process.platform, process.arch);
    if (copied.sha256 !== original.sha256) throw new Error("Package setup helpers do not share the same content identity");
    await writeFile(join(scripts, "preinstall"), preinstall, { mode: 0o755, flag: "wx" });
    await writeFile(join(scripts, "postinstall"), postinstall, { mode: 0o755, flag: "wx" });
    await chmod(join(scripts, "preinstall"), 0o755);
    await chmod(join(scripts, "postinstall"), 0o755);
    const componentPlist = join(staging, "components.plist");
    await writeFile(componentPlist, components, { mode: 0o600, flag: "wx" });
    const temporaryPackage = join(staging, "native-setup.pkg");
    await command("/usr/bin/pkgbuild", ["--root", payload, "--component-plist", componentPlist,
      "--scripts", scripts, "--identifier", identifier,
      "--version", version, "--install-location", dirname(installedApp), "--ownership", "recommended", temporaryPackage], ownership, 180_000);
    const sha256 = await packageDigest(temporaryPackage);
    await link(temporaryPackage, output); // Exclusive publication: never overwrite another package.
    return { packagePath: output, version, architecture: process.arch, unsigned: true, installedApp,
      sha256, installerSHA256: original.sha256, qualification: "not_performed" };
  } catch (error) {
    if (ownership.unknownClosure) throw new Error(`Native setup build closure is unknown; preserve staging at ${staging}`, { cause: error });
    throw error;
  } finally {
    if (!ownership.unknownClosure) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) {
    console.error("Usage: build-native-setup-package.mjs /absolute/packaged.app /absolute/output.pkg");
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await buildNativeSetupPackage(process.argv[2], process.argv[3]))); }
    catch (error) { console.error(error instanceof Error ? error.message : "Native setup package build failed"); process.exitCode = 1; }
  }
}
