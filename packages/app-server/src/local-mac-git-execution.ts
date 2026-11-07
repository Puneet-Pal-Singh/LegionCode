import { fstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  executeSingleProcessMac,
  SingleProcessMacLifetimeUncertainError,
  type SingleExecutableProcessInput,
} from "@legioncode/execution-engine/runtime/desktop/SingleExecutableProcess";
import { GitServiceError } from "@repo/git-service/errors";
import type { GitCommandExecutionResult } from "@repo/git-service/executor";

export type MacGitCommand = {
  cwd: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  indexFile?: string;
  stdin?: string;
  timeoutMs: number;
};

/** Borrowed authority, never obtained by reopening the workspace pathname. */
export type MacGitAuthority = Pick<
  SingleExecutableProcessInput,
  "cwdFd" | "signal" | "sandbox"
>;

export type VerifiedMacGitExecution = {
  readonly scope: "single_executable_nofork";
  run(input: MacGitCommand): Promise<
    GitCommandExecutionResult & {
      readonly quiescent: boolean;
      readonly truncated: boolean;
      readonly outputClosed: boolean;
    }
  >;
};

export type VerifiedMacGitOptions = {
  purpose: "repo_probe";
  probeRoot: string;
  /** Private host composition selects both trusted canonical executables. */
  gitExecutable: string;
  processHelperPath: string;
  /**
   * The grant owner pins its real FileHandle through verified process closure.
   * A rejected operation carries no quiescence receipt: quarantine its pin
   * rather than releasing it in a finally block. Regrant/revoke aborts signal.
   */
  withRootAuthority<T>(
    cwd: string,
    operation: (authority: MacGitAuthority) => Promise<T>,
  ): Promise<T>;
};

const MAX_INPUT_BYTES = 1_000_000;
const unavailable = (message: string) =>
  new GitServiceError("git_process_containment_unavailable", message);

/**
 * Read-only Git transport readiness uses the real canonical guardian. The Git
 * owner supplies readOnlyProbe so optional index writes and fsmonitor are off.
 * This adapter supplies no artifact/index-transaction capability receipt.
 */
export async function createVerifiedMacGitExecution(
  options: VerifiedMacGitOptions,
): Promise<VerifiedMacGitExecution> {
  if (process.platform !== "darwin" || options.purpose !== "repo_probe")
    throw unavailable("Canonical Mac repository probing requires Darwin");
  for (const path of [options.gitExecutable, options.processHelperPath]) {
    if (!isAbsolute(path) || path.includes("\0") || realpathSync(path) !== path)
      throw unavailable("Git and its guardian require trusted canonical paths");
  }

  const run: VerifiedMacGitExecution["run"] = async (request) => {
    if (
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 30_000
    )
      throw unavailable("Git deadline is outside the canonical bound");
    if (
      request.stdin !== undefined &&
      Buffer.byteLength(request.stdin) > MAX_INPUT_BYTES
    )
      throw unavailable("Private Git input exceeds its bound");
    if (request.indexFile !== undefined)
      throw unavailable("Repository probes cannot select a private Git index");

    // Canonical executor environments include ambient non-Git keys. The OS
    // owner supplies fixed PATH/HOME/TMPDIR; only this Git switch crosses over.
    const environment: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0" };
    for (const [key, value] of Object.entries(request.environment)) {
      if (!key.toUpperCase().startsWith("GIT_")) continue;
      if (key !== "GIT_OPTIONAL_LOCKS" || value !== "0")
        throw unavailable("Repository probes reject Git environment overrides");
    }

    return await options.withRootAuthority(request.cwd, async (authority) => {
      if (
        authority.sandbox.scope !== "single_executable_nofork" ||
        authority.sandbox.filesystemRoot !== request.cwd ||
        !Number.isSafeInteger(authority.cwdFd) ||
        authority.cwdFd < 3 ||
        !fstatSync(authority.cwdFd).isDirectory()
      )
        throw unavailable("Git requires the current held-root descriptor");

      const input: SingleExecutableProcessInput = {
        executable: options.gitExecutable,
        args: request.args,
        cwd: request.cwd,
        cwdFd: authority.cwdFd,
        sandbox: authority.sandbox,
        processHelperPath: options.processHelperPath,
        environment,
        stdin: request.stdin,
        // This reaches the C guardian, independently of the host timer.
        timeoutMs: request.timeoutMs,
        signal: AbortSignal.any([
          authority.signal,
          AbortSignal.timeout(request.timeoutMs),
        ]),
      };
      const operation = executeSingleProcessMac(input);
      const result = await operation.result;
      if (!operation.quiescent || result.outputClosed)
        throw new SingleProcessMacLifetimeUncertainError(
          "Mac Git process closure was not proved",
        );
      return {
        ...result,
        exitCode: result.timedOut ? 124 : (result.exitCode ?? 1),
        quiescent: true,
      };
    });
  };

  const version = await run({
    cwd: options.probeRoot,
    args: ["--version"],
    environment: {},
    timeoutMs: 5_000,
  });
  if (
    version.exitCode !== 0 ||
    version.truncated ||
    version.outputClosed ||
    !version.quiescent ||
    !version.stdout.trim().startsWith("git version ")
  )
    throw unavailable("Canonical Mac Git readiness was not proved");

  return { scope: "single_executable_nofork", run };
}
