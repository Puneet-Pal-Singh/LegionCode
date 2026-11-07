import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import type {
  GitCommandExecutor,
  GitCommandExecutionInput,
  GitCommandExecutionResult,
} from "@repo/git-service/executor";
import {
  gitCommandEnvironment,
  gitCommandRunnerArgs,
  gitCommandRunnerEnvironment,
  gitIndexTransactionHostSource,
  parseGitIndexTransactionResult,
} from "@repo/git-service/executor";
import { GitServiceError } from "@repo/git-service/errors";

export type LocalGitContainedCommand = {
  cwd: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  indexFile?: string;
  stdin?: string;
  timeoutMs: number;
};
/** Adapter supplied by the existing canonical Mac OS process owner. It must pass
 * the trusted environment/stdin and return only after SingleProcessMacExecution
 * confirms quiescence. No arbitrary executable or shell comes from the client. */
export type LocalGitMacExecution = {
  readonly scope: "single_executable_nofork";
  /** Set only after real private-index input and transaction contract proof. */
  readonly supportsIndexTransactions?: true;
  run(
    input: LocalGitContainedCommand,
  ): Promise<
    GitCommandExecutionResult & {
      readonly quiescent: boolean;
      readonly truncated: boolean;
      readonly outputClosed: boolean;
    }
  >;
};

export function createNodeGitExecutor(
  options: { macExecution?: LocalGitMacExecution } = {},
): GitCommandExecutor {
  const supported =
    process.platform === "linux" ||
    (process.platform === "darwin" &&
      options.macExecution?.scope === "single_executable_nofork" &&
      options.macExecution.supportsIndexTransactions === true);
  return {
    ...(supported ? { supportsIndexTransactions: true as const } : {}),
    async execute(input) {
      try {
        gitCommandEnvironment({}, input.environment);
      } catch {
        throw new GitServiceError(
          "invalid_git_input",
          "Unsupported canonical Git environment override",
        );
      }
      if (process.platform === "darwin") {
        const runner = options.macExecution;
        if (!runner)
          throw new GitServiceError(
            "git_process_containment_unavailable",
            "Canonical Mac single-process Git execution is not composed",
          );
        const executeContainedGit = async (
          request: LocalGitContainedCommand,
        ) => {
          const result = await runner.run(request);
          if (!result.quiescent || result.outputClosed)
            throw new GitServiceError(
              "git_commit_indeterminate",
              "Canonical Mac Git execution did not prove process closure",
            );
          if (result.truncated)
            return {
              exitCode: 1,
              stdout: "",
              stderr: "Contained Git output was truncated",
              quiescent: true,
            };
          return result;
        };
        // Compile only fixed canonical implementation source; request data and the
        // OS capability are separate arguments, never interpolated executable code.
        const run = compileFunction(gitIndexTransactionHostSource(), [
          "require",
          "input",
          "executeContainedGit",
        ]) as (
          require: ReturnType<typeof createRequire>,
          input: GitCommandExecutionInput,
          execute: typeof executeContainedGit,
        ) => Promise<GitCommandExecutionResult>;
        return await run(
          createRequire(import.meta.url),
          input,
          executeContainedGit,
        );
      }
      if (process.platform !== "linux")
        throw new GitServiceError(
          "git_process_containment_unavailable",
          "Git descendant containment is unavailable on this platform",
        );
      const result = await new Promise<GitCommandExecutionResult>(
        (resolve, reject) => {
          const child = spawn(process.execPath, gitCommandRunnerArgs(input), {
            cwd: input.cwd,
            env: {
              ...gitCommandEnvironment(process.env),
              ...gitCommandRunnerEnvironment(input),
              ELECTRON_RUN_AS_NODE: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (data) => {
            stdout += data;
          });
          child.stderr.on("data", (data) => {
            stderr += data;
          });
          child.once("error", reject);
          child.once("close", (code) =>
            resolve({ exitCode: code ?? 1, stdout, stderr }),
          );
        },
      );
      try {
        const decoded = parseGitIndexTransactionResult(result.stdout);
        if (decoded.exitCode === 126)
          throw new GitServiceError(
            "git_process_containment_unavailable",
            decoded.stderr,
          );
        return decoded;
      } catch (error) {
        if (error instanceof GitServiceError) throw error;
        throw new GitServiceError(
          "git_commit_indeterminate",
          "Git execution outcome is unavailable; do not retry automatically",
        );
      }
    },
  };
}
