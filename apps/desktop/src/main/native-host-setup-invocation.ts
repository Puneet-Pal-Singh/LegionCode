import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const INSTALLED_INSTALLER = "/Library/PrivilegedHelperTools/dev.legioncode.desktop.native-host-installer";
const MAX_OUTPUT_BYTES = 4_096;
const INSPECTION_TIMEOUT_MS = 30_000;
const activeInvocations = new Set<ChildProcess>();

// Only argv is variable. Each complete argument is independently shell quoted
// by AppleScript; neither the renderer nor selected paths supply script source.
const CONFIGURE_SCRIPT = `on run argv
  if (count of argv) is not 6 then error "Invalid native setup invocation"
  set commandText to quoted form of (item 1 of argv)
  repeat with argumentValue in items 2 thru 6 of argv
    set commandText to commandText & " " & quoted form of (contents of argumentValue)
  end repeat
  return do shell script commandText with administrator privileges
end run`;

export class NativeHostSetupUnconfirmedError extends Error {
  constructor() {
    super("Native setup did not return a confirmed completion receipt. Its original outcome must be recovered before retrying.");
    this.name = "NativeHostSetupUnconfirmedError";
  }
}

type ToolchainSelection = Readonly<{
  installerPath: string;
  nodePath: string;
  npmDirectory: string;
}>;

export async function runNativeHostToolchainInspection(
  input: ToolchainSelection,
): Promise<void> {
  try {
    const selection = captureToolchain(input);
    if (process.platform !== "darwin" || await realpath(selection.installerPath) !== selection.installerPath) {
      throw new Error("Invalid native inspection helper");
    }
    const output = await invoke(selection.installerPath, [
      "--inspect-toolchain", selection.nodePath, selection.npmDirectory,
    ], false);
    if (output.length !== 0) throw new Error("Invalid native inspection response");
  } catch {
    throw new Error("Native toolchain inspection did not complete successfully.");
  }
}

export async function runNativeHostConfigure(
  input: ToolchainSelection & Readonly<{ actorUid: number; namespacePath: string }>,
): Promise<{ setupPermitId: string }> {
  let selection: ToolchainSelection;
  let actorUid: number;
  let namespacePath: string;
  try {
    selection = captureToolchain(input);
    actorUid = input.actorUid;
    namespacePath = capturePath(input.namespacePath);
    if (process.platform !== "darwin" || selection.installerPath !== INSTALLED_INSTALLER ||
        !Number.isSafeInteger(actorUid) || actorUid < 1 || actorUid > 4_294_967_294) {
      throw new Error("Invalid native setup selection");
    }
  } catch {
    throw new NativeHostSetupUnconfirmedError();
  }
  const output = await invoke("/usr/bin/osascript", [
    "-e", CONFIGURE_SCRIPT, "--", selection.installerPath, "--configure",
    String(actorUid), namespacePath, selection.nodePath, selection.npmDirectory,
  ], true);
  // do shell script strips its result's final newline; osascript prints one.
  // Accept only that receipt and, at most, one additional output newline.
  const receipt = /^LC_NATIVE_SETUP_V1:([0-9a-f]{64})\n(?:\n)?$/u.exec(output);
  if (!receipt) throw new NativeHostSetupUnconfirmedError();
  return Object.freeze({ setupPermitId: receipt[1]! });
}

function captureToolchain(input: ToolchainSelection): ToolchainSelection {
  return Object.freeze({
    installerPath: capturePath(input.installerPath),
    nodePath: capturePath(input.nodePath),
    npmDirectory: capturePath(input.npmDirectory),
  });
}

function capturePath(path: string): string {
  if (typeof path !== "string" || path.length > 4_096 || path.includes("\0") ||
      !isAbsolute(path) || resolve(path) !== path || path === "/") {
    throw new Error("Native setup requires an explicit absolute path.");
  }
  return path;
}

/** A receipt is accepted only after the ORIGINAL process and stdio close.
 * Privileged invocations have no timer, cancellation or automatic retry: an
 * administrator prompt and any root effects remain owned until actual close.
 */
function invoke(executable: string, args: readonly string[], privileged: boolean): Promise<string> {
  const failure = () => privileged
    ? new NativeHostSetupUnconfirmedError()
    : new Error("Native toolchain inspection did not complete successfully.");
  return new Promise((resolveInvocation, rejectInvocation) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
        windowsHide: true,
      });
    } catch {
      rejectInvocation(failure());
      return;
    }
    activeInvocations.add(child);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let stderrBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const markFailed = () => { failed = true; };
    child.once("error", markFailed);
    child.stdout?.on("error", markFailed);
    child.stderr?.on("error", markFailed);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        failed = true;
        chunks.length = 0;
      } else if (!failed) chunks.push(Buffer.from(chunk));
    });
    // Drain diagnostics without retaining, logging or exposing their contents.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) failed = true;
    });
    if (!child.stdout || !child.stderr) failed = true;
    if (!privileged) {
      timer = setTimeout(() => {
        failed = true;
        // Inspection has no root effects. A signal remains no closure receipt;
        // retain this original child and await its actual close event below.
        child.kill("SIGKILL");
      }, INSPECTION_TIMEOUT_MS);
    }
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      activeInvocations.delete(child);
      if (failed || code !== 0 || signal !== null) {
        chunks.length = 0;
        rejectInvocation(failure());
      } else {
        const output = Buffer.concat(chunks).toString("utf8");
        chunks.length = 0;
        resolveInvocation(output);
      }
    });
  });
}
