import { createHash } from "node:crypto";
import { fstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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
export type MacGitAuthority = {
  /** Borrowed from the existing grant owner; retained until the callback settles. */
  cwdFd: number;
  signal: AbortSignal;
  sandbox: {
    filesystemRoot: string;
    runtimeReadRoots: readonly string[];
    network: "denied";
    writeScope: "workspace";
  };
};
/** Structural view of the canonical 06 primitive, not another OS runner. */
export type CanonicalMacGitProcess = (input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  cwdFd: number;
  signal: AbortSignal;
  sandbox: MacGitAuthority["sandbox"];
  processHelperPath: string;
  environment: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs: number;
}) => {
  readonly scope: "single_executable_nofork";
  readonly quiescent: boolean;
  readonly result: Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
    outputClosed: boolean;
  }>;
};
export type VerifiedMacGitExecution = {
  readonly scope: "single_executable_nofork";
  /** Transport readiness only; does not authorize artifact commits. */
  readonly privateInputsVerified?: true;
  run(input: MacGitCommand): Promise<
    GitCommandExecutionResult & {
      quiescent: boolean;
      truncated: boolean;
      outputClosed: boolean;
    }
  >;
};
export type VerifiedMacGitOptions = {
  purpose: "repo_probe" | "artifact_commit";
  probeRoot: string;
  gitExecutable: string;
  processHelperPath: string;
  executeSingleProcessMac: CanonicalMacGitProcess;
  /** Uses the same held-root authority as grant/bind/execution. Never reopens cwd. */
  withRootAuthority<T>(
    cwd: string,
    operation: (authority: MacGitAuthority) => Promise<T>,
  ): Promise<T>;
};

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const unavailable = (message: string) =>
  new GitServiceError("git_process_containment_unavailable", message);

/** Production readiness calls use the real primitive and receipt. No profile,
 * raw-spawn fallback, provider/kernel construction or claimed boolean proof. */
export async function createVerifiedMacGitExecution(
  options: VerifiedMacGitOptions,
): Promise<VerifiedMacGitExecution> {
  if (process.platform !== "darwin")
    throw unavailable("Canonical Mac Git execution requires Darwin");
  if (
    !isAbsolute(options.gitExecutable) ||
    realpathSync(options.gitExecutable) !== options.gitExecutable
  ) {
    throw unavailable(
      "Git executable must be a trusted canonical runtime path",
    );
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
    const environment: Record<string, string> = {};
    // These are private Git-owner inputs. Fixed PATH/HOME/TMPDIR remain owned by 06.
    if (request.indexFile !== undefined) {
      if (!isAbsolute(request.indexFile) || request.indexFile.includes("\0"))
        throw unavailable("Invalid private Git index path");
      environment.GIT_INDEX_FILE = request.indexFile;
    }
    if (request.environment.GIT_OPTIONAL_LOCKS !== undefined) {
      if (request.environment.GIT_OPTIONAL_LOCKS !== "0")
        throw unavailable("Unsupported Git optional-lock setting");
      environment.GIT_OPTIONAL_LOCKS = "0";
    }
    if (
      Object.keys(request.environment).some(
        (key) => key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS",
      )
    ) {
      throw unavailable(
        "Mac local Git does not accept selectors, credentials or Git config environment overrides",
      );
    }
    return await options.withRootAuthority(request.cwd, async (authority) => {
      if (
        authority.sandbox.filesystemRoot !== request.cwd ||
        !Number.isSafeInteger(authority.cwdFd) ||
        authority.cwdFd < 0 ||
        !fstatSync(authority.cwdFd).isDirectory()
      ) {
        throw unavailable("Git requires the current held-root descriptor");
      }
      const operation = options.executeSingleProcessMac({
        executable: options.gitExecutable,
        args: request.args,
        cwd: request.cwd,
        cwdFd: authority.cwdFd,
        sandbox: authority.sandbox,
        processHelperPath: options.processHelperPath,
        environment,
        stdin: request.stdin,
        timeoutMs: request.timeoutMs,
        signal: AbortSignal.any([
          authority.signal,
          AbortSignal.timeout(request.timeoutMs),
        ]),
      });
      if (operation.scope !== "single_executable_nofork")
        throw unavailable("Git requires the canonical no-fork scope");
      const result = await operation.result;
      if (!operation.quiescent || result.outputClosed)
        throw new GitServiceError(
          "git_commit_indeterminate",
          "Mac Git lifetime is not proven; do not retry automatically",
        );
      return {
        ...result,
        exitCode: result.timedOut ? 124 : (result.exitCode ?? 1),
        quiescent: operation.quiescent,
      };
    });
  };
  const probe = async (
    args: readonly string[],
    extra: Partial<MacGitCommand> = {},
  ) => {
    const result = await run({
      cwd: options.probeRoot,
      args,
      environment: {},
      timeoutMs: 5000,
      ...extra,
    });
    if (
      result.exitCode !== 0 ||
      result.truncated ||
      result.outputClosed ||
      !result.quiescent
    )
      throw unavailable("Canonical Mac Git readiness was not proved");
    return result.stdout.trim();
  };
  const version = await probe(["--version"]);
  if (!version.startsWith("git version "))
    throw unavailable("Canonical Git executable readiness was not proved");
  if (options.purpose === "repo_probe")
    return { scope: "single_executable_nofork", run };
  const realIndex = await probe([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  const privateIndex = join(dirname(realIndex), "index.legioncode-capability");
  if (
    (await probe(
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      { indexFile: privateIndex },
    )) !== privateIndex
  ) {
    throw unavailable(
      "Canonical OS runner did not apply the private Git index environment",
    );
  }
  const format = await probe(["rev-parse", "--show-object-format"]);
  if (format !== "sha1" && format !== "sha256")
    throw unavailable("Unsupported Git object format");
  const input = "legion-private-git-input\n";
  const expected = createHash(format)
    .update(`blob ${Buffer.byteLength(input)}\0${input}`)
    .digest("hex");
  if ((await probe(["hash-object", "--stdin"], { stdin: input })) !== expected)
    throw unavailable("Canonical OS runner did not deliver private Git stdin");
  // This proves private input delivery, not the artifact transaction/hook
  // integration. The Git executor must keep artifact support disabled until
  // that boundary is wired and verified with the production Mac runner.
  return {
    scope: "single_executable_nofork",
    privateInputsVerified: true,
    run,
  };
}
