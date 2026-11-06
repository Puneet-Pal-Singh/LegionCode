import type {
  GitCommandExecutionInput,
  GitCommandExecutionResult,
} from "./executor.js";

/** Runs inside the execution host, never in a client or renderer. */
export const GIT_INDEX_TRANSACTION_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
(async () => {
  const input = JSON.parse(process.argv[1]);
  // Fail before any lock/staging/HEAD operation on platforms whose pre-HEAD hook
  // policy has not been proved. A post-commit comparison is not authorization.
  if (input.indexTransaction && input.indexTransaction.expectedTerminalTreeId !== undefined && process.platform !== "linux") {
    process.stdout.write(JSON.stringify({ exitCode: 126, stdout: "", stderr: "Immutable artifact commits are unavailable: pre-HEAD OS hook policy is not proved" }));
    return;
  }
  const environment = { ...process.env, ...input.environment };
  delete environment.GIT_INDEX_FILE;
  const deadline = Date.now() + (input.timeoutMs || 30000);
  const run = (args, index, inspection = false, stdin) => new Promise((resolve, reject) => {
    const remaining = inspection ? 5000 : deadline - Date.now();
    if (remaining <= 0) return resolve({ exitCode: 124, stdout: "", stderr: "Git transaction timed out" });
    const child = spawn("git", args, {
      cwd: input.cwd,
      env: index ? { ...environment, GIT_INDEX_FILE: index } : environment,
      detached: true, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let stdout = "", stderr = "", timedOut = false, killTimer;
    const killGroup = (signal) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 250);
    }, remaining);
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (timedOut) killGroup("SIGKILL");
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr: timedOut ? "Git transaction timed out" : stderr });
    });
  });
  let lockPath, lockFd, lockIdentity, directory, committed = false, published = false;
  let result;
  const required = async (args, index) => {
    const value = await run(args, index);
    if (value.exitCode !== 0) throw Object.assign(new Error(value.stderr || value.stdout || "Git command failed"), { result: value });
    return value.stdout.trim();
  };
  const ownsLock = () => {
    try { const current = fs.lstatSync(lockPath); return current.dev === lockIdentity.dev && current.ino === lockIdentity.ino; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  try {
    const indexPath = await required(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    lockPath = indexPath + ".lock";
    lockFd = fs.openSync(lockPath, "wx", 0o600);
    lockIdentity = fs.fstatSync(lockFd);
    directory = fs.mkdtempSync(path.join(path.dirname(indexPath), "legion-index-"));
    fs.chmodSync(directory, 0o700);
    const privateIndex = path.join(directory, "index");
    try { fs.copyFileSync(indexPath, privateIndex, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "ENOENT") throw error; await required(["read-tree", "--empty"], privateIndex); }
    const presentPaths = input.indexTransaction.paths.filter(candidate => {
      try { fs.lstatSync(path.resolve(input.cwd, candidate)); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    });
    // Native commit --only handles missing tracked and already-staged deletions.
    // Passing an already-staged deletion to add would reject its absent path.
    if (presentPaths.length) await required(["--literal-pathspecs", "add", "--", ...presentPaths], privateIndex);
    const headState = async () => {
      const head = await run(["rev-parse", "--verify", "HEAD"], undefined, true);
      if (head.exitCode === 0 && /^[a-f0-9]{40,64}$/.test(head.stdout.trim())) return head.stdout.trim();
      const symbolic = await run(["symbolic-ref", "HEAD"], undefined, true);
      if (head.exitCode === 128 && symbolic.exitCode === 0) {
        const missing = await run(["show-ref", "--verify", "--quiet", symbolic.stdout.trim()], undefined, true);
        if (missing.exitCode === 1) return "unborn:" + symbolic.stdout.trim();
      }
      throw new Error("Cannot establish Git HEAD state");
    };
    const beforeHead = await headState();
    const branchName = await required(["branch", "--show-current"]);
    if (!branchName) throw new Error("Git commit requires a named branch");
    let commitIndex = privateIndex;
    let commitArgs = input.args;
    const guard = input.indexTransaction;
    if (guard.expectedTerminalTreeId) {
      const conflict = () => { throw Object.assign(new Error("Immutable artifact content conflict"), { result: { exitCode: 1, stdout: "", stderr: "Immutable artifact content conflict", artifactConflict: true } }); };
      if (guard.expectedHeadSha && beforeHead !== guard.expectedHeadSha) conflict();
      // Preserve native partial-commit refusal during an unfinished Git operation.
      for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
        const statePath = await required(["rev-parse", "--path-format=absolute", "--git-path", state]);
        if (fs.existsSync(statePath)) conflict();
      }
      const absentPaths = guard.paths.filter(candidate => !presentPaths.includes(candidate));
      if (absentPaths.length) await required(["--literal-pathspecs", "update-index", "--force-remove", "--", ...absentPaths], privateIndex);
      for (const tree of [guard.expectedTerminalTreeId, guard.expectedBaselineTreeId].filter(Boolean)) {
        const leaves = await required(["--literal-pathspecs", "ls-tree", "-z", tree, "--", ...guard.paths]);
        if (leaves.split("\0").some(entry => entry.startsWith("040000 "))) conflict();
      }
      if (guard.expectedBaselineTreeId) {
        const baseline = await run(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--quiet", beforeHead, guard.expectedBaselineTreeId, "--", ...guard.paths]);
        if (baseline.exitCode === 1) conflict();
        if (baseline.exitCode !== 0) throw Object.assign(new Error(baseline.stderr), { result: baseline });
      }
      const matches = await run(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--cached", "--quiet", guard.expectedTerminalTreeId, "--", ...guard.paths], privateIndex);
      if (matches.exitCode === 1) conflict();
      if (matches.exitCode !== 0) throw Object.assign(new Error(matches.stderr), { result: matches });
      const entries = await run(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...guard.paths], privateIndex);
      if (entries.exitCode !== 0) throw Object.assign(new Error(entries.stderr), { result: entries });
      commitIndex = path.join(directory, "commit-index");
      await required(["read-tree", beforeHead.startsWith("unborn:") ? "--empty" : beforeHead], commitIndex);
      await required(["--literal-pathspecs", "update-index", "--force-remove", "--", ...guard.paths], commitIndex);
      const installed = await run(["update-index", "-z", "--index-info"], commitIndex, false, entries.stdout);
      if (installed.exitCode !== 0) throw Object.assign(new Error(installed.stderr), { result: installed });
      // Commit only the validated immutable index. Never re-read live files via --only.
      const separator = input.args.indexOf("--");
      const hooks = path.join(directory, "guarded-hooks");
      commitArgs = input.args.slice(0, separator < 0 ? input.args.length : separator).filter(value => value !== "--only");
      if (process.platform === "linux") {
        const originalHooks = await required(["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
        fs.mkdirSync(hooks, { mode: 0o700 });
        fs.writeFileSync(path.join(hooks, "package.json"), JSON.stringify({ type: "commonjs" }), { mode: 0o600 });
        fs.writeFileSync(path.join(hooks, "guard.json"), JSON.stringify({ originalHooks, cwd: input.cwd, index: commitIndex, terminalTree: guard.expectedTerminalTreeId, beforeHead, paths: guard.paths }), { mode: 0o600 });
        const wrapper = "#!/usr/bin/env node\nconst fs = require(\"node:fs\");\nconst path = require(\"node:path\");\nconst { spawnSync } = require(\"node:child_process\");\nconst config = JSON.parse(fs.readFileSync(path.join(__dirname, \"guard.json\"), \"utf8\"));\nconst name = path.basename(process.argv[1]);\nconst original = path.join(config.originalHooks, name);\nconst fail = (message, code = 1) => {\n  fs.appendFileSync(path.join(__dirname, \"failure\"), name + \": \" + message + \"\\n\");\n  process.stderr.write(\"legion-artifact-guard-conflict: \" + message + \"\\n\");\n  process.exit(code);\n};\ntry {\n  fs.accessSync(original, fs.constants.X_OK);\n  const result = spawnSync(original, process.argv.slice(2), { stdio: \"inherit\", env: process.env });\n  if (result.error || result.status !== 0) fail(\"Repository hook failed\", result.status || 1);\n} catch (error) {\n  if (error.code !== \"ENOENT\" && error.code !== \"EACCES\") fail(\"Repository hook could not be inspected\");\n}\nconst environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith(\"GIT_\")));\nconst currentIndex = path.resolve(process.env.GIT_INDEX_FILE || config.index);\nif (path.dirname(currentIndex) !== path.dirname(config.index)) fail(\"Repository hook received an unexpected index context\");\nenvironment.GIT_INDEX_FILE = currentIndex;\nenvironment.GIT_OPTIONAL_LOCKS = \"0\";\nconst git = args => spawnSync(\"git\", [\"--work-tree=\" + config.cwd, \"-c\", \"core.fsmonitor=false\", ...args], { cwd: config.cwd, env: environment, encoding: \"utf8\", maxBuffer: 16 * 1024 * 1024 });\nconst selected = git([\"--literal-pathspecs\", \"diff\", \"--no-ext-diff\", \"--no-textconv\", \"--cached\", \"--quiet\", config.terminalTree, \"--\", ...config.paths]);\nconst changed = git([\"diff\", \"--no-ext-diff\", \"--no-textconv\", \"--cached\", \"--name-only\", \"-z\", config.beforeHead]);\nif (selected.status !== 0 || changed.status !== 0 || changed.stdout.split(\"\\0\").filter(Boolean).some(value => !config.paths.includes(value))) {\n  fail(\"Repository hook changed immutable artifact content or additional paths\");\n}\n";
        for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) fs.writeFileSync(path.join(hooks, name), wrapper, { mode: 0o700 });
        commitArgs = ["-c", "core.hooksPath=" + hooks, ...commitArgs];
      }

    }
    result = await run(commitArgs, commitIndex);
    if (result.exitCode !== 0) {
      if (guard.expectedTerminalTreeId && result.stderr.includes("legion-artifact-guard-conflict:")) result = { ...result, artifactConflict: true };
      let unchanged = false;
      try { unchanged = (await headState()) === beforeHead; } catch {}
      if (!unchanged) {
        committed = true;
        result = { ...result, artifactConflict: undefined, indexPublication: "indeterminate" };
      }
    }
    if (result.exitCode === 0) {
      committed = true;
      const commitSha = await headState();
      if (commitSha.startsWith("unborn:")) throw new Error("Git did not produce a commit");
      result = { ...result, commitSha, branchName };
      if (guard.expectedTerminalTreeId) {
        const verified = await run(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--quiet", guard.expectedTerminalTreeId, commitSha, "--", ...guard.paths], undefined, true);
        const changed = await run(["diff", "--name-only", "-z", beforeHead, commitSha], undefined, true);
        const finalIndex = await run(["diff", "--no-ext-diff", "--no-textconv", "--cached", "--quiet", commitSha], commitIndex, true);
        if (finalIndex.exitCode !== 0 || fs.existsSync(path.join(directory, "guarded-hooks", "failure"))) throw new Error("Repository hook changed or failed after the artifact commit; inspect outcome");
        if (verified.exitCode !== 0 || changed.exitCode !== 0 || changed.stdout.split("\0").filter(Boolean).some(candidate => !guard.paths.includes(candidate))) {
          throw new Error("Git hooks changed the immutable artifact commit; outcome requires inspection");
        }
      }
      if (!ownsLock()) throw new Error("Git index lock ownership changed before publication");
      fs.writeFileSync(lockFd, fs.readFileSync(privateIndex));
      fs.fsyncSync(lockFd);
      fs.renameSync(lockPath, indexPath);
      published = true;
    }
  } catch (error) {
    result = error.result || { exitCode: 1, stdout: "", stderr: error.message };
    if (committed) result = { ...result, indexPublication: "indeterminate" };
  } finally {
    if (lockFd !== undefined) {
      if (!published && ownsLock()) fs.unlinkSync(lockPath);
      fs.closeSync(lockFd);
    }
    // Keep the private index as recovery evidence if HEAD advanced but publication failed.
    if (directory && (!committed || published)) fs.rmSync(directory, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(result));
})().catch(error => {
  process.stdout.write(JSON.stringify({ exitCode: 1, stdout: "", stderr: error.message, indexPublication: "indeterminate" }));
  process.exitCode = 1;
});
`;

export function gitIndexTransactionArgs(
  input: GitCommandExecutionInput,
): string[] {
  if (!input.indexTransaction || !input.args.includes("commit")) {
    throw new Error(
      "Git index transactions require a canonical commit operation",
    );
  }
  // Toolbox accepts only single-line arguments. This is fixed source, not user code.
  const script = GIT_INDEX_TRANSACTION_SCRIPT.replace(
    /^\s*\/\/.*$/gm,
    "",
  ).replace(/\r?\n/g, " ");
  return ["-e", script, JSON.stringify(input)];
}

export function parseGitIndexTransactionResult(
  stdout: string,
): GitCommandExecutionResult {
  const value: unknown = JSON.parse(stdout);
  if (
    typeof value !== "object" ||
    value === null ||
    !("exitCode" in value) ||
    typeof value.exitCode !== "number" ||
    !("stdout" in value) ||
    typeof value.stdout !== "string" ||
    !("stderr" in value) ||
    typeof value.stderr !== "string" ||
    ("artifactConflict" in value && value.artifactConflict !== true) ||
    ("indexPublication" in value &&
      value.indexPublication !== "indeterminate") ||
    ("commitSha" in value && typeof value.commitSha !== "string") ||
    ("branchName" in value && typeof value.branchName !== "string")
  ) {
    throw new Error("Git index transaction returned an invalid result");
  }
  return value as GitCommandExecutionResult;
}
