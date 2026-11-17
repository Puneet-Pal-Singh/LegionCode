import { isAbsolute, resolve } from "node:path";

/** Adapter failure code for runtime capability reporting; never select a fallback. */
export class SingleProcessMacCapabilityError extends Error {
  readonly code = "single_executable_nofork_unavailable" as const;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SingleProcessMacCapabilityError";
  }
}

/** Private process scope. Workspace root binds cwd/environment, not host authority. */
export type SingleProcessMacSandbox = {
  scope: "single_executable_nofork";
  filesystemRoot: string;
};

/**
 * One fixed OS process policy: no subprocesses or direct signals to other PIDs.
 * The ordinary approved executable retains invoking-user filesystem/network/IPC
 * authority. A private read-only Git probe additionally denies writes, network
 * and exec of any executable other than its exact selected Git binary.
 */
export function buildSingleProcessMacSandbox(
  executable: string,
  sandbox: SingleProcessMacSandbox,
  readOnlyProbe?: true,
): { profile: string; parameters: string[] } {
  const validPath = (path: string) =>
    typeof path === "string" &&
    isAbsolute(path) &&
    resolve(path) === path &&
    path !== "/" &&
    !path.includes("\0") &&
    Buffer.byteLength(path) <= 4_096;
  if (
    (readOnlyProbe !== undefined && readOnlyProbe !== true) ||
    !sandbox ||
    sandbox.scope !== "single_executable_nofork" ||
    Object.keys(sandbox).sort().join(",") !== "filesystemRoot,scope" ||
    !validPath(sandbox.filesystemRoot) ||
    !validPath(executable)
  ) {
    throw new SingleProcessMacCapabilityError(
      "Unsupported single-process scope; restrictive filesystem/network policies are not implemented",
    );
  }
  // This string labels cwd/environment only. The separately held descriptor
  // is the directory authority; do not resolve/reopen a competing root here.
  const rules = [
    "(version 1)",
    "(allow default)",
    "(deny process-fork)",
    "(deny signal (require-not (target self)))",
  ];
  if (readOnlyProbe) {
    // SBPL uses Scheme string literals, not JSON or interpolated regexes.
    // Reject control bytes rather than relying on unsupported escape syntax.
    if (/[\u0000-\u001f\u007f]/u.test(executable)) {
      throw new SingleProcessMacCapabilityError(
        "Read-only Git requires a literal executable path",
      );
    }
    const literal = `"${executable.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
    rules.push(
      // Git opens this OS-owned character device O_RDWR even for status.
      // No ordinary file or workspace metadata gains write authority.
      '(deny file-write* (require-not (literal "/dev/null")))',
      "(deny network*)",
      `(deny process-exec (require-not (literal ${literal})))`,
    );
  }
  return {
    profile: rules.join("\n"),
    parameters: [],
  };
}
