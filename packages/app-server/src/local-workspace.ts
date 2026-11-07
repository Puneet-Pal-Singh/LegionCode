import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type {
  LocalPersistence,
  StoredLocalWorkspaceGrant,
} from "@repo/event-store/local";
import {
  GrantLocalWorkspaceRequestSchema,
  LocalWorkspaceGrantSchema,
  LocalWorkspaceReadinessSchema,
  WorkspaceIdSchema,
  workspaceIdFromExternalId,
  type LocalWorkspaceGrant,
} from "@repo/platform-protocol";
import { DefaultGitService, type GitCommandExecutor } from "@repo/git-service";

export type LocalWorkspaceServiceOptions = {
  workspaceGrants: LocalPersistence["workspaceGrants"];
  gitService?: Pick<DefaultGitService, "probeRepository">;
};

export class LocalWorkspaceService {
  private readonly workspaceGrants: LocalWorkspaceServiceOptions["workspaceGrants"];
  private readonly gitService: Pick<
    DefaultGitService,
    "probeRepository"
  >;

  constructor(options: LocalWorkspaceServiceOptions) {
    this.workspaceGrants = options.workspaceGrants;
    this.gitService = options.gitService ?? new DefaultGitService(createNodeGitExecutor());
  }

  async getCurrent(): Promise<LocalWorkspaceGrant | null> {
    const stored = await this.workspaceGrants.read();
    if (!stored) {
      return null;
    }
    return await this.probeStoredGrant(stored);
  }

  async grant(input: unknown): Promise<LocalWorkspaceGrant> {
    const { path } = GrantLocalWorkspaceRequestSchema.parse(input);
    const canonicalPath = await validateSelectedDirectory(path);
    const { repoRoot, probe } = await this.readRepository(canonicalPath);
    if (repoRoot !== canonicalPath) {
      throw new Error("Workspace selection must be the repository root");
    }
    const grant = buildGrant(repoRoot, probe, null);
    const stored = {
      version: 1 as const,
      path: repoRoot,
      grant,
    };
    await this.workspaceGrants.write(stored);
    return grant;
  }

  async revoke(): Promise<void> {
    await this.workspaceGrants.clear();
  }

  private async probeStoredGrant(
    stored: StoredLocalWorkspaceGrant,
  ): Promise<LocalWorkspaceGrant> {
    try {
      const canonicalPath = await validateSelectedDirectory(stored.path);
      const { repoRoot, probe } = await this.readRepository(canonicalPath);
      if (repoRoot !== stored.path) {
        return invalidGrant(stored.grant, "Authorized repository path changed");
      }
      return buildGrant(repoRoot, probe, stored.grant);
    } catch (error) {
      return invalidGrant(
        stored.grant,
        "Authorized workspace is missing or no longer a Git repository",
      );
    }
  }

  private async readRepository(path: string) {
    const probe = await this.gitService.probeRepository({ workspaceRoot: path });
    return { repoRoot: await realpath(probe.repositoryRoot), probe };
  }

}

function buildGrant(
  repoRoot: string,
  probe: Awaited<ReturnType<DefaultGitService["probeRepository"]>>,
  previous: LocalWorkspaceGrant | null,
): LocalWorkspaceGrant {
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
