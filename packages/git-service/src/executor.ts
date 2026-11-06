import type { RunId } from "@repo/platform-protocol";

export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 30_000;

export interface GitCommandExecutionInput {
  readonly runId?: RunId;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly indexTransaction?: {
    readonly paths: readonly string[];
    readonly expectedTerminalTreeId?: string;
    readonly expectedBaselineTreeId?: string;
    readonly expectedHeadSha?: string;
  };
}

export interface GitCommandExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly indexPublication?: "indeterminate";
  readonly artifactConflict?: true;
  readonly commitSha?: string;
  readonly branchName?: string;
}

export interface GitCommandExecutor {
  readonly supportsIndexTransactions?: true;
  execute(input: GitCommandExecutionInput): Promise<GitCommandExecutionResult>;
}

export {
  gitIndexTransactionArgs,
  parseGitIndexTransactionResult,
} from "./index-transaction.js";
