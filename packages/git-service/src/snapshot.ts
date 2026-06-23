import { RunIdSchema } from "@repo/platform-protocol";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type GitCommandExecutor,
} from "./executor.js";
import { createGitCommandFailedError, GitServiceError } from "./errors.js";
import type {
  GitChangedFileStatus,
  GitDiffFile,
  GitDiffResult,
  GitSnapshotDiffInput,
  GitSnapshotInput,
  GitWorkspaceSnapshot,
} from "./types.js";
import { validateWorkspaceRoot } from "./validation.js";

const OBJECT_ID_PATTERN = /^[a-f0-9]{40,64}$/u;
const SNAPSHOT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;

export async function captureGitWorkspaceSnapshot(
  executor: GitCommandExecutor,
  input: GitSnapshotInput,
): Promise<GitWorkspaceSnapshot> {
  const runId = RunIdSchema.parse(input.workspace.runId);
  const filesystemRoot = validateWorkspaceRoot(input.workspace.filesystemRoot);
  const snapshotKey = validateSnapshotKey(input.snapshotKey);
  const indexPath = await readGitValue(executor, runId, filesystemRoot, [
    "rev-parse",
    "--git-path",
    `index.legioncode-${snapshotKey}`,
  ]);
  const environment = { GIT_INDEX_FILE: indexPath };
  await executeGit(
    executor,
    runId,
    filesystemRoot,
    ["read-tree", "HEAD"],
    environment,
  );
  await executeGit(executor, runId, filesystemRoot, ["add", "-A"], environment);
  const treeId = validateObjectId(
    await readGitValue(
      executor,
      runId,
      filesystemRoot,
      ["write-tree"],
      environment,
    ),
  );
  const headSha = validateObjectId(
    await readGitValue(executor, runId, filesystemRoot, ["rev-parse", "HEAD"]),
  );
  return { runId, filesystemRoot, headSha, treeId };
}

export async function diffGitWorkspaceSnapshots(
  executor: GitCommandExecutor,
  input: GitSnapshotDiffInput,
): Promise<GitDiffResult> {
  const runId = RunIdSchema.parse(input.workspace.runId);
  const filesystemRoot = validateWorkspaceRoot(input.workspace.filesystemRoot);
  assertSnapshotIdentity(input.start, runId, filesystemRoot);
  assertSnapshotIdentity(input.terminal, runId, filesystemRoot);
  const range = [input.start.treeId, input.terminal.treeId];
  const names = await readGitValue(
    executor,
    runId,
    filesystemRoot,
    ["diff", "--name-status", "-z", "--find-renames", ...range],
    undefined,
    false,
  );
  const stats = await readGitValue(
    executor,
    runId,
    filesystemRoot,
    ["diff", "--numstat", "-z", "--find-renames", ...range],
    undefined,
    false,
  );
  const patch = await readGitValue(
    executor,
    runId,
    filesystemRoot,
    ["diff", "--no-ext-diff", "--find-renames", "--binary", ...range],
    undefined,
    false,
  );
  return { files: mergeDiffFiles(names, stats), patch };
}

async function executeGit(
  executor: GitCommandExecutor,
  runId: ReturnType<typeof RunIdSchema.parse>,
  cwd: string,
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await executor.execute({
    runId,
    cwd,
    args,
    environment,
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw createGitCommandFailedError(
      args,
      result.exitCode,
      result.stderr.trim(),
    );
  }
  return result.stdout;
}

async function readGitValue(
  executor: GitCommandExecutor,
  runId: ReturnType<typeof RunIdSchema.parse>,
  cwd: string,
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
  trim = true,
): Promise<string> {
  const output = await executeGit(executor, runId, cwd, args, environment);
  return trim ? output.trim() : output;
}

function validateSnapshotKey(value: string): string {
  if (!SNAPSHOT_KEY_PATTERN.test(value)) {
    throw new GitServiceError("invalid_git_input", "Invalid snapshot key");
  }
  return value;
}

function validateObjectId(value: string): string {
  if (!OBJECT_ID_PATTERN.test(value)) {
    throw new GitServiceError(
      "git_command_failed",
      "Git returned an invalid object ID",
    );
  }
  return value;
}

function assertSnapshotIdentity(
  snapshot: GitWorkspaceSnapshot,
  runId: string,
  filesystemRoot: string,
): void {
  if (snapshot.runId !== runId || snapshot.filesystemRoot !== filesystemRoot) {
    throw new GitServiceError(
      "invalid_git_input",
      "Snapshot belongs to another workspace",
    );
  }
  validateObjectId(snapshot.treeId);
}

function mergeDiffFiles(nameOutput: string, statOutput: string): GitDiffFile[] {
  const files = parseNameStatus(nameOutput);
  const stats = parseNumstat(statOutput);
  return files.map((file) => ({
    ...file,
    additions: stats.get(file.path)?.additions ?? 0,
    deletions: stats.get(file.path)?.deletions ?? 0,
  }));
}

function parseNameStatus(
  output: string,
): Omit<GitDiffFile, "additions" | "deletions">[] {
  const tokens = output.split("\0").filter(Boolean);
  const files: Omit<GitDiffFile, "additions" | "deletions">[] = [];
  for (let index = 0; index < tokens.length; ) {
    const parsed = readStatusToken(tokens, index);
    files.push(parsed.file);
    index = parsed.nextIndex;
  }
  return files;
}

function readStatusToken(
  tokens: readonly string[],
  index: number,
): { file: Omit<GitDiffFile, "additions" | "deletions">; nextIndex: number } {
  const first = tokens[index] ?? "";
  const [inlineStatus, inlinePath] = first.split("\t", 2);
  const statusToken = inlinePath === undefined ? first : (inlineStatus ?? "");
  const status = mapStatus(statusToken);
  const pathIndex = inlinePath === undefined ? index + 1 : index;
  const path = inlinePath ?? tokens[pathIndex] ?? "";
  if (status === "renamed" || status === "copied") {
    const nextPath = tokens[pathIndex + 1] ?? "";
    return {
      file: { path: nextPath, previousPath: path, status },
      nextIndex: pathIndex + 2,
    };
  }
  return {
    file: { path, previousPath: null, status },
    nextIndex: pathIndex + 1,
  };
}

function mapStatus(token: string): GitChangedFileStatus {
  const code = token[0];
  const statuses: Record<string, GitChangedFileStatus> = {
    A: "added",
    C: "copied",
    D: "deleted",
    M: "modified",
    R: "renamed",
    T: "type_changed",
    U: "unmerged",
  };
  const status = code ? statuses[code] : undefined;
  if (!status)
    throw new GitServiceError("malformed_status_output", "Invalid diff status");
  return status;
}

function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const tokens = output.split("\0").filter(Boolean);
  const result = new Map<string, { additions: number; deletions: number }>();
  for (let index = 0; index < tokens.length; index += 1) {
    const [added, deleted, path] = (tokens[index] ?? "").split("\t");
    const stats = {
      additions: parseCount(added),
      deletions: parseCount(deleted),
    };
    if (path) result.set(path, stats);
    else {
      const terminalPath = tokens[index + 2];
      if (terminalPath) result.set(terminalPath, stats);
      index += 2;
    }
  }
  return result;
}

function parseCount(value: string | undefined): number {
  if (value === "-") return 0;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new GitServiceError(
      "malformed_status_output",
      "Invalid diff statistic",
    );
  }
  return count;
}
