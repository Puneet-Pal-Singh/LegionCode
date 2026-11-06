import { realpathSync } from "node:fs";
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
 * The approved executable retains normal invoking-user filesystem/network/IPC
 * authority. This is deliberately not a workspace or network sandbox.
 */
export function buildSingleProcessMacSandbox(
  executable: string,
  sandbox: SingleProcessMacSandbox,
): { profile: string; parameters: string[] } {
  const validPath = (path: string) => typeof path === "string" && isAbsolute(path)
    && resolve(path) !== "/" && !path.includes("\0") && Buffer.byteLength(path) <= 4_096;
  if (!sandbox || sandbox.scope !== "single_executable_nofork"
    || Object.keys(sandbox).sort().join(",") !== "filesystemRoot,scope"
    || !validPath(sandbox.filesystemRoot) || !validPath(executable)) {
    throw new SingleProcessMacCapabilityError("Unsupported single-process scope; restrictive filesystem/network policies are not implemented");
  }
  try {
    if (realpathSync(sandbox.filesystemRoot) !== sandbox.filesystemRoot) {
      throw new SingleProcessMacCapabilityError("Workspace binding must be canonical");
    }
  } catch (error) {
    if (error instanceof SingleProcessMacCapabilityError) throw error;
    throw new SingleProcessMacCapabilityError("Workspace binding is unavailable", error);
  }
  return {
    profile: [
      "(version 1)",
      "(allow default)",
      "(deny process-fork)",
      "(deny signal (require-not (target self)))",
    ].join("\n"),
    parameters: [],
  };
}
