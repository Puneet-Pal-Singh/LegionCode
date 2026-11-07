import type {
  GitCommandExecutionInput,
  GitCommandExecutionResult,
} from "./executor.js";
import { GitServiceError } from "./errors.js";

/** Runtime-private filesystem port. The native owner retains the real lock and
 * writer open description; this canonical Git module owns only Git policy. */
export interface NativeGitIndexSession {
  readonly originalExists: boolean;
  readonly finalized: boolean;
  filePath(name: string): string;
  verify(): Promise<void>;
  inspectEntries(
    paths: readonly string[],
  ): Promise<readonly (0 | 1 | 2 | 3 | 4)[]>;
  inspectExecutables(paths: readonly string[]): Promise<readonly (0 | 1 | 2)[]>;
  publish(source: string): Promise<void>;
  abort(): Promise<void>;
  quarantine(): Promise<void>;
}

export interface NativeGitTransactionPort {
  readonly session: NativeGitIndexSession;
  readonly unknown: boolean;
  assertActive(): Promise<void> | void;
  execute(
    args: readonly string[],
    indexFile: string | undefined,
    stdin: string | undefined,
    timeoutMs: number,
    settling: boolean,
  ): Promise<GitCommandExecutionResult>;
}

const failure = (stderr: string, exitCode = 1): GitCommandExecutionResult => ({
  exitCode,
  stdout: "",
  stderr,
});
class NativeGitTransactionFailure extends Error {
  constructor(readonly result: GitCommandExecutionResult) {
    super(result.stderr || "Git transaction failed");
  }
}
const objectId = /^[a-f0-9]{40,64}$/u;
const hooks = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "reference-transaction",
  "post-rewrite",
  "post-index-change",
];
const operationMarkers = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
  "BISECT_LOG",
];

/** No-hook Darwin transaction. commit-tree receives saved immutable entries;
 * update-ref performs the expected-old named-branch CAS. User hooks are never disabled. */
export async function executeNativeIndexTransaction(
  input: GitCommandExecutionInput,
  port: NativeGitTransactionPort,
): Promise<GitCommandExecutionResult> {
  const guard = input.indexTransaction;
  const args = input.args;
  if (
    !guard?.expectedTerminalTreeId ||
    args.length !== 10 + guard.paths.length ||
    args[0] !== "-c" ||
    !args[1]?.startsWith("user.name=") ||
    args[2] !== "-c" ||
    !args[3]?.startsWith("user.email=") ||
    args[4] !== "--literal-pathspecs" ||
    args[5] !== "commit" ||
    args[6] !== "--only" ||
    args[7] !== "-m" ||
    args[9] !== "--" ||
    guard.paths.some((path, i) => args[i + 10] !== path) ||
    input.environment !== undefined ||
    input.stdin !== undefined
  ) {
    await port.session.abort();
    return failure(
      "Native immutable commit requires the canonical guarded command",
      126,
    );
  }
  const deadline = Date.now() + Math.min(input.timeoutMs ?? 30_000, 30_000);
  const session = port.session;
  let mayHaveAdvanced = false;
  let committed = false;
  let beforeHead: string | undefined;
  let branchRef: string | undefined;
  const run = async (
    command: readonly string[],
    index?: string,
    stdin?: string,
  ) => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs < 1)
      throw new NativeGitTransactionFailure(
        failure("Git transaction deadline expired", 124),
      );
    if (!mayHaveAdvanced) await port.assertActive();
    await session.verify();
    return await port.execute(command, index, stdin, timeoutMs, committed);
  };
  const required = async (
    command: readonly string[],
    index?: string,
    stdin?: string,
  ) => {
    const result = await run(command, index, stdin);
    if (result.exitCode !== 0) throw new NativeGitTransactionFailure(result);
    return result.stdout;
  };
  const conflict = (): never => {
    throw new NativeGitTransactionFailure({
      ...failure("Immutable artifact content or baseline changed"),
      artifactConflict: true,
    });
  };
  const refuse = (message: string): never => {
    throw new NativeGitTransactionFailure(failure(message, 126));
  };
  const assertDirectBranch = async () => {
    const symbolic = await run([
      "symbolic-ref",
      "--quiet",
      "--no-recurse",
      branchRef!,
    ]);
    if (symbolic.exitCode === 0)
      refuse("Native immutable commit does not support symbolic branch refs");
    if (symbolic.exitCode !== 1)
      throw new NativeGitTransactionFailure(symbolic);
  };
  const verifyPolicy = async () => {
    if (
      (
        await session.inspectEntries(
          operationMarkers.map((name) => `.git/${name}`),
        )
      ).some((kind) => kind !== 0)
    )
      refuse(
        "Native immutable commit does not support a pending Git operation",
      );
    const signing = await run(["config", "--bool", "--get", "commit.gpgSign"]);
    if (signing.exitCode !== 0 && signing.exitCode !== 1)
      throw new NativeGitTransactionFailure(signing);
    if (signing.exitCode === 0 && signing.stdout.trim() !== "false")
      refuse(
        "Configured commit signing requires an unsupported signer process",
      );
    const cleanup = await run(["config", "--get", "commit.cleanup"]);
    if (cleanup.exitCode !== 0 && cleanup.exitCode !== 1)
      throw new NativeGitTransactionFailure(cleanup);
    if (
      cleanup.exitCode === 0 &&
      !["default", "whitespace", "verbatim"].includes(cleanup.stdout.trim())
    )
      refuse(
        "Configured commit message cleanup requires unsupported commit porcelain",
      );
    const hookPath = await required(["rev-parse", "--git-path", "hooks"]);
    // Git adds one LF; whitespace can be part of a configured directory name.
    const directory = hookPath.endsWith("\n")
      ? hookPath.slice(0, -1)
      : hookPath;
    // External/alias hook roots need separately held authority, never a Node path
    // fallback. Relative core.hooksPath semantics remain relative to held cwd.
    const parts = directory.replace(/^\.\//u, "").split("/");
    if (
      !directory ||
      directory.startsWith("/") ||
      directory.includes("\\") ||
      directory.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      refuse(
        "The configured hook directory requires unavailable retained authority",
      );
    const states = await session.inspectExecutables(
      hooks.map((name) => `${parts.join("/")}/${name}`),
    );
    if (states.some((state) => state !== 0))
      refuse(
        "Executable or uninspectable Git hooks require a process scope unavailable before HEAD publication",
      );
  };
  const finalize = async () => {
    if (session.finalized) return;
    try {
      if (mayHaveAdvanced || committed || port.unknown)
        await session.quarantine();
      else await session.abort();
    } catch {
      throw new GitServiceError(
        "git_commit_indeterminate",
        "Native transaction finalization could not be established",
      );
    }
  };
  try {
    await verifyPolicy();
    branchRef = (
      await required(["symbolic-ref", "--no-recurse", "HEAD"])
    ).trim();
    if (!branchRef.startsWith("refs/heads/") || branchRef.length === 11)
      refuse("Native immutable commit requires a named branch");
    await assertDirectBranch();
    const head = await run(["rev-parse", "--verify", "HEAD"]);
    if (head.exitCode === 0 && objectId.test(head.stdout.trim()))
      beforeHead = head.stdout.trim();
    else {
      const missing = await run(["show-ref", "--verify", "--quiet", branchRef]);
      if (head.exitCode !== 128 || missing.exitCode !== 1)
        throw new NativeGitTransactionFailure(head);
    }
    if (guard.expectedHeadSha && beforeHead !== guard.expectedHeadSha)
      conflict();
    const beforeTree =
      beforeHead ?? (await required(["mktree"], undefined, "")).trim();
    for (const tree of [
      guard.expectedTerminalTreeId,
      guard.expectedBaselineTreeId,
    ].filter((tree): tree is string => tree !== undefined)) {
      const entries = await required([
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        tree,
        "--",
        ...guard.paths,
      ]);
      if (entries.split("\0").some((entry) => entry.startsWith("040000 ")))
        conflict();
    }
    if (guard.expectedBaselineTreeId) {
      const baseline = await run([
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--quiet",
        beforeTree,
        guard.expectedBaselineTreeId,
        "--",
        ...guard.paths,
      ]);
      if (baseline.exitCode === 1) conflict();
      if (baseline.exitCode !== 0)
        throw new NativeGitTransactionFailure(baseline);
    }
    const staged = session.filePath("selected-index"),
      user = session.filePath("index"),
      fixed = session.filePath("commit-index");
    const seed = beforeHead
      ? ["read-tree", beforeHead]
      : ["read-tree", "--empty"];
    // Load blob IDs, modes and deletions from the saved terminal tree. Snapshot
    // selection must never inspect or stage a later version of a live file.
    await required(["read-tree", guard.expectedTerminalTreeId], staged);
    const matches = await run(
      [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--cached",
        "--quiet",
        guard.expectedTerminalTreeId,
        "--",
        ...guard.paths,
      ],
      staged,
    );
    if (matches.exitCode === 1) conflict();
    if (matches.exitCode !== 0) throw new NativeGitTransactionFailure(matches);
    const entries = await required(
      [
        "--literal-pathspecs",
        "ls-files",
        "--stage",
        "-z",
        "--",
        ...guard.paths,
      ],
      staged,
    );
    if (!session.originalExists) await required(["read-tree", "--empty"], user);
    // Baseline-equivalent index entries are unmodified staging. Already-staged
    // artifact entries are also safe, but any other selected staging belongs to
    // the user and must survive as a conflict without publishing either index.
    const selectedStaging = (
      await required(
        [
          "--literal-pathspecs",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--cached",
          "--name-only",
          "-z",
          beforeTree,
          "--",
          ...guard.paths,
        ],
        user,
      )
    )
      .split("\0")
      .filter(Boolean);
    if (selectedStaging.some((path) => !guard.paths.includes(path))) conflict();
    if (selectedStaging.length) {
      const selectedMatches = await run(
        [
          "--literal-pathspecs",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--cached",
          "--quiet",
          guard.expectedTerminalTreeId,
          "--",
          ...selectedStaging,
        ],
        user,
      );
      if (selectedMatches.exitCode === 1) conflict();
      if (selectedMatches.exitCode !== 0)
        throw new NativeGitTransactionFailure(selectedMatches);
    }
    await required(seed, fixed);
    for (const index of [fixed, user]) {
      await required(
        [
          "--literal-pathspecs",
          "update-index",
          "--force-remove",
          "--",
          ...guard.paths,
        ],
        index,
      );
      await required(["update-index", "-z", "--index-info"], index, entries);
    }
    const tree = (await required(["write-tree"], fixed)).trim();
    if (!objectId.test(tree))
      throw new NativeGitTransactionFailure(
        failure("Git did not produce a fixed commit tree"),
      );
    const changed = await run([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--quiet",
      beforeTree,
      tree,
    ]);
    if (changed.exitCode === 0)
      throw new NativeGitTransactionFailure(
        failure("No selected artifact changes to commit"),
      );
    if (changed.exitCode !== 1) throw new NativeGitTransactionFailure(changed);
    const sha = (
      await required([
        ...args.slice(0, 4),
        "commit-tree",
        tree,
        ...(beforeHead ? ["-p", beforeHead] : []),
        "-m",
        args[8]!,
      ])
    ).trim();
    if (!objectId.test(sha))
      throw new NativeGitTransactionFailure(
        failure("Git did not produce a commit object"),
      );
    // Recheck effective hooks/signing and original branch immediately before CAS.
    await verifyPolicy();
    if (
      (await required(["symbolic-ref", "--no-recurse", "HEAD"])).trim() !==
      branchRef
    )
      conflict();
    await assertDirectBranch();
    await port.assertActive();
    await session.verify();
    mayHaveAdvanced = true;
    const update = await run([
      "update-ref",
      "--no-deref",
      "-m",
      `commit: ${args[8]}`,
      branchRef,
      sha,
      beforeHead ?? "0".repeat(sha.length),
    ]);
    if (update.exitCode !== 0) {
      const after = await run(["rev-parse", "--verify", branchRef]);
      const unchanged = beforeHead
        ? after.exitCode === 0 && after.stdout.trim() === beforeHead
        : after.exitCode === 128;
      if (!unchanged) return { ...update, indexPublication: "indeterminate" };
      mayHaveAdvanced = false;
      throw new NativeGitTransactionFailure({
        ...update,
        artifactConflict: true,
      });
    }
    committed = true;
    const finalHead = (
      await required(["rev-parse", "--verify", "HEAD"])
    ).trim();
    const finalBranch = (
      await required(["symbolic-ref", "--no-recurse", "HEAD"])
    ).trim();
    if (finalHead !== sha || finalBranch !== branchRef)
      throw new NativeGitTransactionFailure(
        failure("HEAD or its branch changed during publication"),
      );
    await session.publish("index");
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      commitSha: sha,
      branchName: branchRef.slice(11),
    };
  } catch (error) {
    const result =
      error instanceof NativeGitTransactionFailure
        ? error.result
        : failure(
            error instanceof Error
              ? error.message
              : "Native Git transaction failed",
          );
    return mayHaveAdvanced || committed || port.unknown
      ? { ...result, indexPublication: "indeterminate" }
      : result;
  } finally {
    await finalize();
  }
}
