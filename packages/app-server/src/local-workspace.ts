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
import type { DefaultGitService } from "@repo/git-service";
import type { VerifiedMacGitOptions } from "./local-mac-git-execution.js";
import { LocalWorkspaceRootPin } from "./local-workspace-root-pin.js";

export type LocalWorkspaceServiceOptions = {
  workspaceGrants: LocalPersistence["workspaceGrants"];
  /** Trusted host storage/app/helper locations; never workspace request fields. */
  protectedHostRoots?: readonly string[];
  gitService?: Pick<DefaultGitService, "probeRepository">;
  createProbeService?: (authority: Pick<VerifiedMacGitOptions, "probeRoot" | "withRootAuthority">) => Promise<Pick<DefaultGitService, "probeRepository">>;
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
  /** Retained authority only for authorized final settlement of the same admitted scope. */
  assertSettlementCurrent(): void;
}

export class LocalWorkspaceService {
  private generation = 0;
  private transitioning = false;
  private executionController = new AbortController();
  private readonly protectedHostRoots: readonly string[];
  private readonly workspaceGrants: LocalWorkspaceServiceOptions["workspaceGrants"];
  private readonly gitService: LocalWorkspaceServiceOptions["gitService"];
  private readonly createProbeService: LocalWorkspaceServiceOptions["createProbeService"];
  // Strong references are intentional: unknown physical closure must not let GC close/reuse an FD.
  private readonly quarantinedPins = new Set<LocalWorkspaceRootPin>();

  constructor(options: LocalWorkspaceServiceOptions) {
    this.workspaceGrants = options.workspaceGrants;
    this.protectedHostRoots = Object.freeze([...(options.protectedHostRoots ?? [])]);
    if (options.gitService && options.createProbeService) throw new Error("Repository probe owner must be explicit");
    this.gitService = options.gitService;
    this.createProbeService = options.createProbeService;
  }

  async getCurrent(): Promise<LocalWorkspaceGrant | null> {
    if (this.transitioning) return null;
    const generation = this.generation;
    const signal = this.executionController.signal;
    const stored = await this.workspaceGrants.read();
    if (!stored || generation !== this.generation) return null;
    this.assertProbingAvailable();
    const grant = await this.probeStoredGrant(stored, generation, signal);
    if (generation !== this.generation || this.transitioning) return null;
    this.assertProbingAvailable();
    signal.throwIfAborted();
    return grant;
  }

  async grant(input: unknown): Promise<LocalWorkspaceGrant> {
    this.assertProbingAvailable();
    const { path } = GrantLocalWorkspaceRequestSchema.parse(input);
    const generation = this.invalidateExecutionBindings();
    const signal = this.executionController.signal;
    this.transitioning = true;
    try {
    const canonicalPath = await validateSelectedDirectory(path);
    await this.assertOutsideProtectedRoots(canonicalPath);
    const { repoRoot, probe } = await this.readRepository(canonicalPath, generation, signal);
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
    this.assertProbingAvailable();
    if (this.transitioning) throw new Error("Local workspace grant is changing");
    const generation = this.generation;
    const signal = this.executionController.signal;
    const stored = await this.workspaceGrants.read();
    this.assertGeneration(generation);
    if (!stored || stored.grant.workspaceId !== workspaceId) {
      throw new Error("Workspace is not granted for local execution");
    }
    await this.assertOutsideProtectedRoots(stored.path);
    const pin = await this.openRootPin(stored.path, generation, signal);
    try {
      const workspace = await this.probeStoredGrant(stored, generation, signal, pin);
      await pin.assertPathCurrent();
      if (workspace.readiness !== "ready") throw new Error("Workspace is not ready for local execution");
      return Object.freeze({
        workspace, filesystemRoot: stored.path, rootDirectory: pin.rootDirectory, generation, signal,
        close: () => pin.close(),
        assertSettlementCurrent: () => pin.assertSettlementCurrent(),
        assertCurrent: () => {
          pin.assertCurrent();
          if (this.transitioning) throw new Error("Local workspace grant is changing");
        },
      });
    } catch (error) {
      if (!pin.quarantined) await pin.close();
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
    generation: number,
    signal: AbortSignal,
    pin?: LocalWorkspaceRootPin,
  ): Promise<LocalWorkspaceGrant> {
    try {
      const canonicalPath = await validateSelectedDirectory(stored.path);
      await this.assertOutsideProtectedRoots(canonicalPath);
      const { repoRoot, probe } = await this.readRepository(canonicalPath, generation, signal, pin);
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

  private assertProbingAvailable(): void {
    if (this.quarantinedPins.size) throw new Error("Repository probing is quarantined until host restart");
  }

  private async openRootPin(path: string, generation: number, signal: AbortSignal): Promise<LocalWorkspaceRootPin> {
    this.assertProbingAvailable();
    this.assertGeneration(generation);
    signal.throwIfAborted();
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Workspace root is not a real directory");
    const rootDirectory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let pin: LocalWorkspaceRootPin | undefined;
    try {
      const opened = await rootDirectory.stat({ bigint: true });
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("Workspace root changed during binding");
      }
      pin = new LocalWorkspaceRootPin(path, rootDirectory, signal, opened,
        () => { this.assertProbingAvailable(); this.assertGeneration(generation); },
        (unknownPin) => {
          this.quarantinedPins.add(unknownPin);
          this.executionController.abort("Repository probe closure was not proved");
        });
      await pin.assertPathCurrent();
      return pin;
    } catch (error) {
      if (!pin?.quarantined) await rootDirectory.close();
      throw error;
    }
  }

  private async readRepository(path: string, generation: number, signal: AbortSignal, suppliedPin?: LocalWorkspaceRootPin) {
    const pin = suppliedPin ?? await this.openRootPin(path, generation, signal);
    try {
      pin.assertCurrent();
      const service = this.createProbeService
        ? await this.createProbeService({ probeRoot: path, withRootAuthority: pin.withRootAuthority })
        : this.gitService;
      if (!service) throw new Error("Canonical repository probing is unavailable");
      pin.assertCurrent();
      const probe = await service.probeRepository({ workspaceRoot: path });
      await pin.assertPathCurrent();
      const repoRoot = await realpath(probe.repositoryRoot);
      pin.assertCurrent();
      return { repoRoot, probe };
    } finally {
      if (!suppliedPin && !pin.quarantined) await pin.close();
    }
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
