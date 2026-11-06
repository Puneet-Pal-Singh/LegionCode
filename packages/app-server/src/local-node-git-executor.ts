import { spawn } from "node:child_process";
import type {
  GitCommandExecutor,
  GitCommandExecutionResult,
} from "@repo/git-service/executor";
import {
  gitIndexTransactionArgs,
  parseGitIndexTransactionResult,
} from "@repo/git-service/executor";
import { GitServiceError } from "@repo/git-service/errors";

export function createNodeGitExecutor(): GitCommandExecutor {
  return {
    supportsIndexTransactions: true,
    async execute(input) {
      const transaction = input.indexTransaction !== undefined;
      const result = await new Promise<GitCommandExecutionResult>(
        (resolve, reject) => {
          const child = spawn(
            transaction ? process.execPath : "git",
            transaction ? gitIndexTransactionArgs(input) : [...input.args],
            {
              cwd: input.cwd,
              env: {
                ...process.env,
                ...input.environment,
                ...(transaction ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
              },
              detached: !transaction,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "",
            stderr = "",
            timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const kill = (signal: NodeJS.Signals) => {
            if (!child.pid) return;
            try {
              process.kill(-child.pid, signal);
            } catch (error) {
              if (
                !(
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "ESRCH"
                )
              )
                throw error;
            }
          };
          // Transaction runner owns its deadline and waits for Git termination before unlocking.
          if (!transaction)
            timer = setTimeout(() => {
              timedOut = true;
              kill("SIGTERM");
              killTimer = setTimeout(() => kill("SIGKILL"), 250);
            }, input.timeoutMs ?? 30_000);
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            reject(error);
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            if (timedOut) kill("SIGKILL");
            resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr });
          });
        },
      );
      if (!transaction) return result;
      try {
        return parseGitIndexTransactionResult(result.stdout);
      } catch {
        throw new GitServiceError(
          "git_commit_indeterminate",
          "Git transaction outcome is unavailable; do not retry automatically",
        );
      }
    },
  };
}
