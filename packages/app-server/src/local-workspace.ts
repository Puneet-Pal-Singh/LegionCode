import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  GrantLocalWorkspaceRequestSchema,
  LocalWorkspaceGrantSchema,
  LocalWorkspaceReadinessSchema,
  WorkspaceIdSchema,
  workspaceIdFromExternalId,
  type LocalWorkspaceGrant,
} from "@repo/platform-protocol";
import { DefaultGitService, type GitCommandExecutor } from "@repo/git-service";

const STORAGE_VERSION = 1;

type StoredGrant = {
  version: typeof STORAGE_VERSION;
  path: string;
  grant: LocalWorkspaceGrant;
};

export type LocalWorkspaceServiceOptions = {
  storageDirectory: string;
  gitService?: Pick<DefaultGitService, "probeRepository">;
};

export class LocalWorkspaceService {
  private readonly grantPath: string;
  private readonly gitService: Pick<
    DefaultGitService,
    "probeRepository"
  >;

  constructor(options: LocalWorkspaceServiceOptions) {
    if (!isAbsolute(options.storageDirectory)) {
      throw new Error("Local workspace storage directory must be absolute");
    }
    this.grantPath = join(resolve(options.storageDirectory), "workspace-grant.json");
    this.gitService = options.gitService ?? new DefaultGitService(createNodeGitExecutor());
  }

  async getCurrent(): Promise<LocalWorkspaceGrant | null> {
    const stored = await this.readStoredGrant();
    if (!stored) {
      return null;
    }
    return await this.probeStoredGrant(stored);
  }

  async grant(input: unknown): Promise<LocalWorkspaceGrant> {
    const { path } = GrantLocalWorkspaceRequestSchema.parse(input);
    const canonicalPath = await validateSelectedDirectory(path);
    const repoRoot = await this.readRepositoryRoot(canonicalPath);
    if (repoRoot !== canonicalPath) {
      throw new Error("Workspace selection must be the repository root");
    }
    const grant = await this.probeRepository(repoRoot, null);
    const stored: StoredGrant = {
      version: STORAGE_VERSION,
      path: repoRoot,
      grant,
    };
    await this.writeStoredGrant(stored);
    return grant;
  }

  async revoke(): Promise<void> {
    try {
      await unlink(this.grantPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }

  private async readStoredGrant(): Promise<StoredGrant | null> {
    let payload: unknown;
    try {
      payload = JSON.parse(await readFile(this.grantPath, "utf8")) as unknown;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return null;
      }
      throw new Error("Stored workspace grant is corrupt");
    }
    if (!isStoredGrant(payload)) {
      throw new Error("Stored workspace grant is corrupt");
    }
    return payload;
  }

  private async probeStoredGrant(stored: StoredGrant): Promise<LocalWorkspaceGrant> {
    try {
      const canonicalPath = await validateSelectedDirectory(stored.path);
      const repoRoot = await this.readRepositoryRoot(canonicalPath);
      if (repoRoot !== stored.path) {
        return invalidGrant(stored.grant, "Authorized repository path changed");
      }
      return await this.probeRepository(repoRoot, stored.grant);
    } catch (error) {
      return invalidGrant(stored.grant, error instanceof Error ? error.message : "Authorized workspace is unavailable");
    }
  }

  private async readRepositoryRoot(path: string): Promise<string> {
    const root = (await this.gitService.probeRepository({ workspaceRoot: path }))
      .repositoryRoot;
    const canonicalRoot = await realpath(root);
    if (!isPathWithin(canonicalRoot, path) && !isPathWithin(path, canonicalRoot)) {
      throw new Error("Git repository root is outside the selected workspace");
    }
    return canonicalRoot;
  }

  private async probeRepository(
    repoRoot: string,
    previous: LocalWorkspaceGrant | null,
  ): Promise<LocalWorkspaceGrant> {
    const probe = await this.gitService.probeRepository({
      workspaceRoot: repoRoot,
    });
    return LocalWorkspaceGrantSchema.parse({
      workspaceId: previous?.workspaceId ?? workspaceIdForPath(repoRoot),
      displayName: basename(repoRoot),
      repositoryIdentity: probe.repositoryIdentity,
      branch: probe.branch,
      readiness: LocalWorkspaceReadinessSchema.enum.ready,
      capabilities: ["filesystem", "git"],
      reason: null,
      grantedAt: previous?.grantedAt ?? new Date().toISOString(),
    });
  }

  private async writeStoredGrant(stored: StoredGrant): Promise<void> {
    await mkdir(dirname(this.grantPath), { recursive: true });
    const temporaryPath = `${this.grantPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(stored), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.grantPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function invalidGrant(grant: LocalWorkspaceGrant, reason: string): LocalWorkspaceGrant {
  return LocalWorkspaceGrantSchema.parse({
    ...grant,
    readiness: "missing",
    capabilities: [],
    branch: null,
    repositoryIdentity: null,
    reason: reason.slice(0, 500),
  });
}

async function validateSelectedDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("Workspace path must be absolute");
  }
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Workspace selection must be a real directory");
  }
  return await realpath(path);
}

function workspaceIdForPath(path: string) {
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 24);
  return WorkspaceIdSchema.parse(workspaceIdFromExternalId(`local-${digest}`));
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isStoredGrant(value: unknown): value is StoredGrant {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === STORAGE_VERSION &&
    typeof record.path === "string" &&
    LocalWorkspaceGrantSchema.safeParse(record.grant).success
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function createNodeGitExecutor(): GitCommandExecutor {
  return {
    execute: async ({ cwd, args, environment, timeoutMs }) => {
      const { spawn } = await import("node:child_process");
      return await new Promise((resolve) => {
        const child = spawn("git", [...args], {
          cwd,
          env: environment ? { ...process.env, ...environment } : process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;
        const finish = (result: { exitCode: number; stdout: string; stderr: string }) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const timer = setTimeout(() => {
          child.kill();
          finish({ exitCode: 124, stdout: Buffer.concat(stdout).toString(), stderr: "git probe timed out" });
        }, timeoutMs ?? 30_000);
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", (error) => {
          clearTimeout(timer);
          finish({ exitCode: 1, stdout: "", stderr: error.message });
        });
        child.once("close", (exitCode) => {
          clearTimeout(timer);
          finish({ exitCode: exitCode ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
        });
      });
    },
  };
}
