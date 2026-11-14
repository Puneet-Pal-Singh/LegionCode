import type { GitCommandExecutor } from "./executor.js";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS } from "./executor.js";
import { GitServiceError } from "./errors.js";
import type { GitRepositoryMetadataPaths, GitRepositoryProbeInput } from "./types.js";
import { validateWorkspaceRoot } from "./validation.js";

/** Git resolves its own gitfile/common-directory records. These are paths, not
 * physical authority: the execution owner must pin and validate their actual
 * identities, protected storage and aliases before changing access or starting
 * a command. Repeated observations are not an atomic filesystem snapshot.
 */
export async function readGitRepositoryMetadataPaths(
  executor: GitCommandExecutor,
  input: GitRepositoryProbeInput,
): Promise<GitRepositoryMetadataPaths> {
  const workspaceRoot = canonicalPath(validateWorkspaceRoot(input.workspaceRoot));
  const gitEntry = child(workspaceRoot, ".git");
  const inspect = async (args: readonly string[]) => {
    const result = await executor.execute({
      cwd: workspaceRoot, args, readOnlyProbe: true,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.stderr !== "" || result.indexPublication ||
        result.artifactConflict || result.commitSha || result.branchName || !result.stdout.endsWith("\n")) {
      throw unavailable();
    }
    // Preserve actual pathname bytes; trim() would accept a different authority.
    return canonicalPath(result.stdout.slice(0, -1));
  };
  const read = async (): Promise<GitRepositoryMetadataPaths> => {
    const top = await inspect(["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    if (top !== workspaceRoot) throw unavailable();
    const gitDirectory = await inspect(["rev-parse", "--absolute-git-dir"]);
    const commonDirectory = await inspect(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const resolved = await inspect(["rev-parse", "--path-format=absolute", "--resolve-git-dir", gitEntry]);
    // Also bind Git's ambient discovery to this exact checkout's .git entry.
    if (resolved !== gitDirectory) throw unavailable();
    let backlinkPath: string | null = null;
    if (gitDirectory !== commonDirectory) {
      const parent = child(commonDirectory, "worktrees") + "/";
      const name = gitDirectory.slice(parent.length);
      if (!gitDirectory.startsWith(parent) || !name || name.includes("/")) throw unavailable();
      backlinkPath = child(gitDirectory, "gitdir");
    }
    return { version: 1, workspaceRoot, gitEntry, gitDirectory, commonDirectory, backlinkPath };
  };
  const first = await read();
  const current = await read();
  if (first.gitDirectory !== current.gitDirectory || first.commonDirectory !== current.commonDirectory ||
      first.backlinkPath !== current.backlinkPath) throw unavailable();
  return Object.freeze(current);
}

function canonicalPath(path: string): string {
  const invalidCharacter = Array.from(path).some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || code === 0xfffd || (code >= 0xd800 && code <= 0xdfff);
  });
  if (!path.startsWith("/") || new TextEncoder().encode(path).byteLength > 4096 ||
      invalidCharacter ||
      (path !== "/" && path.slice(1).split("/").some(part => !part || part === "." || part === ".."))) {
    throw unavailable();
  }
  return path;
}

function child(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function unavailable(): GitServiceError {
  return new GitServiceError("git_command_failed", "Repository metadata paths are unavailable or changed");
}
