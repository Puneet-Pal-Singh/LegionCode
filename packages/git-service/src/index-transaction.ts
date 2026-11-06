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
  const environment = { ...process.env, ...input.environment };
  delete environment.GIT_INDEX_FILE;
  const deadline = Date.now() + (input.timeoutMs || 30000);
  const run = (args, index, inspection = false) => new Promise((resolve, reject) => {
    const remaining = inspection ? 5000 : deadline - Date.now();
    if (remaining <= 0) return resolve({ exitCode: 124, stdout: "", stderr: "Git transaction timed out" });
    const child = spawn("git", args, {
      cwd: input.cwd,
      env: index ? { ...environment, GIT_INDEX_FILE: index } : environment,
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
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
    result = await run(input.args, privateIndex);
    if (result.exitCode !== 0) {
      let unchanged = false;
      try { unchanged = (await headState()) === beforeHead; } catch {}
      if (!unchanged) {
        committed = true;
        result = { ...result, indexPublication: "indeterminate" };
      }
    }
    if (result.exitCode === 0) {
      committed = true;
      const commitSha = await headState();
      if (commitSha.startsWith("unborn:")) throw new Error("Git did not produce a commit");
      result = { ...result, commitSha, branchName };
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
    ("indexPublication" in value &&
      value.indexPublication !== "indeterminate") ||
    ("commitSha" in value && typeof value.commitSha !== "string") ||
    ("branchName" in value && typeof value.branchName !== "string")
  ) {
    throw new Error("Git index transaction returned an invalid result");
  }
  return value as GitCommandExecutionResult;
}
