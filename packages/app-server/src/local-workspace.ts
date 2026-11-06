import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

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
import { DefaultGitService } from "@repo/git-service";
import { createNodeGitExecutor } from "./local-node-git-executor.js";

export type LocalWorkspaceServiceOptions = {
  workspaceGrants: LocalPersistence["workspaceGrants"];
  /** Trusted host storage/app/helper locations; never workspace request fields. */
  protectedHostRoots?: readonly string[];
  gitService?: Pick<DefaultGitService, "probeRepository">;
};

/** Trusted runtime handle. This physical root is never returned by App Server. */
export interface LocalWorkspaceExecutionBinding {
  readonly workspace: LocalWorkspaceGrant;
  readonly filesystemRoot: string;
  readonly rootDirectory: FileHandle;
  /** Call only after all execution/capture children and pipes have quiesced. */
  close(): Promise<void>;
  readonly generation: number;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export class LocalWorkspaceService {
  private generation = 0;
  private transitioning = false;
  private executionController = new AbortController();
  private readonly protectedHostRoots: readonly string[];
  private readonly workspaceGrants: LocalWorkspaceServiceOptions["workspaceGrants"];
  private readonly gitService: Pick<
    DefaultGitService,
    "probeRepository"
  >;

  constructor(options: LocalWorkspaceServiceOptions) {
    this.workspaceGrants = options.workspaceGrants;
    this.protectedHostRoots = Object.freeze([...(options.protectedHostRoots ?? [])]);
    this.gitService = options.gitService ?? new DefaultGitService(createNodeGitExecutor());
  }

  async getCurrent(): Promise<LocalWorkspaceGrant | null> {
    if (this.transitioning) return null;
    const generation = this.generation;
    const stored = await this.workspaceGrants.read();
    if (!stored || generation !== this.generation) return null;
    const grant = await this.probeStoredGrant(stored);
    return generation === this.generation && !this.transitioning ? grant : null;
  }

  async grant(input: unknown): Promise<LocalWorkspaceGrant> {
    const { path } = GrantLocalWorkspaceRequestSchema.parse(input);
    const generation = this.invalidateExecutionBindings();
    this.transitioning = true;
    try {
    const canonicalPath = await validateSelectedDirectory(path);
    await this.assertOutsideProtectedRoots(canonicalPath);
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
    } finally {
      if (generation === this.generation) this.transitioning = false;
    }
  }

  async revoke(): Promise<void> {
    const generation = this.invalidateExecutionBindings();
    this.transitioning = true;
    try { await this.workspaceGrants.clear(); } finally {
      if (generation === this.generation) this.transitioning = false;
    }
  }

  async bindForExecution(workspaceId: WorkspaceId): Promise<LocalWorkspaceExecutionBinding> {
    if (this.transitioning) throw new Error("Local workspace grant is changing");
    const generation = this.generation;
    const signal = this.executionController.signal;
    const stored = await this.workspaceGrants.read();
    this.assertGeneration(generation);
    if (!stored || stored.grant.workspaceId !== workspaceId) {
      throw new Error("Workspace is not granted for local execution");
    }
    await this.assertOutsideProtectedRoots(stored.path);
    this.assertGeneration(generation);
    const before = await lstat(stored.path);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("Local workspace root is no longer a real directory");
    }
    const rootDirectory = await open(
      stored.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await rootDirectory.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("Local workspace root changed during binding");
      }
      const workspace = await this.probeStoredGrant(stored);
      this.assertGeneration(generation);
      const after = await lstat(stored.path);
      this.assertGeneration(generation);
      if (!after.isDirectory() || after.isSymbolicLink() ||
          after.dev !== opened.dev || after.ino !== opened.ino) {
        throw new Error("Local workspace root changed during binding");
      }
      if (workspace.readiness !== "ready") throw new Error("Workspace is not ready for local execution");
      let closing: Promise<void> | null = null;
      return Object.freeze({
        workspace, filesystemRoot: stored.path, rootDirectory, generation, signal,
        close: () => { closing ??= rootDirectory.close(); return closing; },
        assertCurrent: () => {
          this.assertGeneration(generation);
          if (closing) throw new Error("Local workspace binding is closed");
          if (this.transitioning) throw new Error("Local workspace grant is changing");
        },
      });
    } catch (error) {
      await rootDirectory.close();
      throw error;
    }
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
      await this.assertOutsideProtectedRoots(canonicalPath);
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

  private async assertOutsideProtectedRoots(workspaceRoot: string): Promise<void> {
    for (const configuredRoot of this.protectedHostRoots) {
      if (!isAbsolute(configuredRoot) || configuredRoot.includes("\0")) {
        throw new Error("Protected host root configuration is invalid");
      }
      // Resolve every time: restored grants cannot bypass changed host locations/symlinks.
      const protectedRoot = await realpath(configuredRoot);
      const contains = (parent: string, child: string) => {
        const path = relative(parent, child);
        return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
      };
      if (contains(workspaceRoot, protectedRoot) || contains(protectedRoot, workspaceRoot)) {
        throw new Error("Workspace overlaps protected host storage or application files");
      }
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
