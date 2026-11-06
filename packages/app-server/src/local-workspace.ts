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
  type WorkspaceId,
} from "@repo/platform-protocol";
import { DefaultGitService, type GitCommandExecutor } from "@repo/git-service";

export type LocalWorkspaceServiceOptions = {
  workspaceGrants: LocalPersistence["workspaceGrants"];
  gitService?: Pick<DefaultGitService, "probeRepository">;
};

/** Trusted runtime handle. This physical root is never returned by App Server. */
export interface LocalWorkspaceExecutionBinding {
  readonly workspace: LocalWorkspaceGrant;
  readonly filesystemRoot: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export class LocalWorkspaceService {
  private generation = 0;
  private executionController = new AbortController();
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
    const generation = this.generation;
    const stored = await this.workspaceGrants.read();
    if (!stored || generation !== this.generation) return null;
    const grant = await this.probeStoredGrant(stored);
    return generation === this.generation ? grant : null;
  }

  async grant(input: unknown): Promise<LocalWorkspaceGrant> {
    const { path } = GrantLocalWorkspaceRequestSchema.parse(input);
    const generation = this.invalidateExecutionBindings();
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
    this.assertGeneration(generation);
    await this.workspaceGrants.write(stored);
    this.assertGeneration(generation);
    return grant;
  }

  async revoke(): Promise<void> {
    this.invalidateExecutionBindings();
    await this.workspaceGrants.clear();
  }

  async bindForExecution(workspaceId: WorkspaceId): Promise<LocalWorkspaceExecutionBinding> {
    const generation = this.generation;
    const signal = this.executionController.signal;
    const stored = await this.workspaceGrants.read();
    this.assertGeneration(generation);
    if (!stored || stored.grant.workspaceId !== workspaceId) {
      throw new Error("Workspace is not granted for local execution");
    }
    const workspace = await this.probeStoredGrant(stored);
    this.assertGeneration(generation);
    if (workspace.readiness !== "ready") throw new Error("Workspace is not ready for local execution");
    return Object.freeze({
      workspace, filesystemRoot: stored.path, generation, signal,
      assertCurrent: () => this.assertGeneration(generation),
    });
  }

  private invalidateExecutionBindings(): number {
    this.generation += 1;
    this.executionController.abort("Local workspace grant changed");
    this.executionController = new AbortController();
    return this.generation;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("Local workspace grant changed during the operation");
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
