import {
  parseNativeGitMetadataIdentity,
  type NativeFilesystemBridge,
  type NativeFilesystemExecution,
  type NativeGitMetadataIdentity,
} from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import { randomUUID } from "node:crypto";
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
  createMetadataInspector?: (
    rootDirectory: FileHandle,
    observeExecution: (execution: NativeFilesystemExecution) => void,
  ) => Pick<NativeFilesystemBridge, "inspectGitMetadataIdentity">;
  createProbeService?: (
    authority: Pick<VerifiedMacGitOptions, "probeRoot" | "withRootAuthority">,
  ) => Promise<Pick<DefaultGitService, "probeRepository">>;
};

/** Trusted runtime handle. This physical root is never returned by App Server. */
export interface LocalWorkspaceExecutionBinding {
  readonly workspace: LocalWorkspaceGrant;
  readonly filesystemRoot: string;
  readonly rootDirectory: FileHandle;
  readonly metadataIdentity: NativeGitMetadataIdentity;
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
  private readonly createMetadataInspector: LocalWorkspaceServiceOptions["createMetadataInspector"];
  private readonly createProbeService: LocalWorkspaceServiceOptions["createProbeService"];
  // Strong references are intentional: unknown physical closure must not let GC close/reuse an FD.
  private readonly quarantinedPins = new Set<LocalWorkspaceRootPin>();

  constructor(options: LocalWorkspaceServiceOptions) {
    this.workspaceGrants = options.workspaceGrants;
    this.protectedHostRoots = Object.freeze([
      ...(options.protectedHostRoots ?? []),
    ]);
    if (options.gitService && options.createProbeService)
      throw new Error("Repository probe owner must be explicit");
    this.gitService = options.gitService;
    this.createMetadataInspector = options.createMetadataInspector;
    this.createProbeService = options.createProbeService;
  }

  async getCurrent(): Promise<LocalWorkspaceGrant | null> {
    if (this.transitioning) return null;
    const generation = this.generation;
    const signal = this.executionController.signal;
    const stored = await this.workspaceGrants.read();
    if (!stored || generation !== this.generation) return null;
    if (stored.version !== 2 || stored.grant.readiness !== "ready") {
      this.executionController.abort("Explicit workspace regrant is required");
      return invalidGrant(
        stored.grant,
        "Explicit workspace regrant is required",
      );
    }
    this.assertProbingAvailable();
    const grant = await this.probeStoredGrant(stored, generation, signal);
    if (generation !== this.generation || this.transitioning) return null;
    this.assertProbingAvailable();
    if (grant.readiness !== "ready") return grant;
    signal.throwIfAborted();
    return grant;
  }

  async grant(input: unknown): Promise<LocalWorkspaceGrant> {
    this.assertProbingAvailable();
    const { path } = GrantLocalWorkspaceRequestSchema.parse(input);
    const generation = this.invalidateExecutionBindings();
    const signal = this.executionController.signal;
    this.transitioning = true;
    let pin: LocalWorkspaceRootPin | undefined;
    try {
      const canonicalPath = await validateSelectedDirectory(path);
      await this.assertOutsideProtectedRoots(canonicalPath);
      pin = await this.openRootPin(canonicalPath, generation, signal);
      // Identity inspection is native metadata I/O, and precedes even Git readiness execution.
      const gitMetadataIdentity = await this.inspectIdentity(pin);
      const { repoRoot, probe } = await this.readRepository(
        canonicalPath,
        generation,
        signal,
        pin,
      );
      if (repoRoot !== canonicalPath)
        throw new Error("Workspace selection must be the repository root");
      await this.assertIdentity(pin, gitMetadataIdentity);
      const previous = await this.workspaceGrants.read();
      this.assertGeneration(generation);
      const workspaceId =
        previous?.version === 2 &&
        previous.gitMetadataIdentity === gitMetadataIdentity
          ? previous.grant.workspaceId
          : WorkspaceIdSchema.parse(
              workspaceIdFromExternalId(`local-${randomUUID()}`),
            );
      const grant = buildGrant(repoRoot, probe, workspaceId);
      const stored: Extract<StoredLocalWorkspaceGrant, { version: 2 }> = {
        version: 2,
        path: repoRoot,
        grant,
        gitMetadataIdentity,
      };
      this.assertGeneration(generation);
      this.assertProbingAvailable();
      signal.throwIfAborted();
      await this.workspaceGrants.write(stored);
      await pin.assertPathCurrent();
      this.assertGeneration(generation);
      this.assertProbingAvailable();
      signal.throwIfAborted();
      return grant;
    } finally {
      try {
        if (pin && !pin.quarantined) await pin.close();
      } finally {
        if (generation === this.generation) this.transitioning = false;
      }
    }
  }

  async revoke(): Promise<void> {
    const generation = this.invalidateExecutionBindings();
    this.transitioning = true;
    try { await this.workspaceGrants.clear(); } finally {
      if (generation === this.generation) this.transitioning = false;
    }
  }

  async bindForExecution(
    workspaceId: WorkspaceId,
  ): Promise<LocalWorkspaceExecutionBinding> {
    this.assertProbingAvailable();
    if (this.transitioning)
      throw new Error("Local workspace grant is changing");
    const generation = this.generation;
    const signal = this.executionController.signal;
    const stored = await this.workspaceGrants.read();
    this.assertGeneration(generation);
    if (!stored || stored.grant.workspaceId !== workspaceId) {
      throw new Error("Workspace is not granted for local execution");
    }
    if (stored.version !== 2 || stored.grant.readiness !== "ready") {
      this.executionController.abort("Explicit workspace regrant is required");
      throw new Error("Explicit workspace regrant is required");
    }
    const pin = await (async () => {
      try {
        await this.assertOutsideProtectedRoots(stored.path);
        return await this.openRootPin(stored.path, generation, signal);
      } catch (error) {
        await this.requireRegrant(
          stored,
          generation,
          "Workspace root is unavailable; explicit regrant is required",
        );
        throw error;
      }
    })();
    try {
      const workspace = await this.probeStoredGrant(
        stored,
        generation,
        signal,
        pin,
      );
      await pin.assertPathCurrent();
      if (workspace.readiness !== "ready")
        throw new Error(
          "Workspace is not ready for local execution; regrant may be required",
        );
      await this.assertStoredGrantCurrent(stored, generation, signal);
      const metadataIdentity = parseNativeGitMetadataIdentity(stored.gitMetadataIdentity);
      return Object.freeze({
        workspace,
        filesystemRoot: stored.path,
        rootDirectory: pin.rootDirectory,
        metadataIdentity,
        generation,
        signal,
        close: () => pin.close(),
        assertSettlementCurrent: () => pin.assertSettlementCurrent(),
        assertCurrent: () => {
          pin.assertCurrent();
          if (this.transitioning)
            throw new Error("Local workspace grant is changing");
        },
      });
    } catch (error) {
      if (!pin.quarantined) await pin.close();
      throw error;
    }
  }

  /** Host-only verified record: preserve private identity; never return this record through HTTP. */
  async requireExecutionGrant(
    workspaceId: WorkspaceId,
  ): Promise<Extract<StoredLocalWorkspaceGrant, { version: 2 }>> {
    const generation = this.generation;
    const signal = this.executionController.signal;
    const stored = await this.workspaceGrants.read();
    this.assertGeneration(generation);
    if (
      !stored ||
      stored.version !== 2 ||
      stored.grant.workspaceId !== workspaceId
    ) {
      if (stored?.version === 1)
        this.executionController.abort(
          "Explicit workspace regrant is required",
        );
      throw new Error("The local workspace requires explicit regrant");
    }
    const binding = await this.bindForExecution(workspaceId);
    try {
      await this.assertStoredGrantCurrent(stored, generation, signal);
      binding.assertCurrent();
      return { ...stored, grant: binding.workspace };
    } finally {
      await binding.close();
    }
  }

  private async assertStoredGrantCurrent(
    stored: Extract<StoredLocalWorkspaceGrant, { version: 2 }>,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.workspaceGrants.read();
    this.assertGeneration(generation);
    this.assertProbingAvailable();
    signal.throwIfAborted();
    if (
      !current ||
      current.version !== 2 ||
      current.path !== stored.path ||
      current.gitMetadataIdentity !== stored.gitMetadataIdentity ||
      current.grant.readiness !== "ready" ||
      current.grant.workspaceId !== stored.grant.workspaceId ||
      current.grant.grantedAt !== stored.grant.grantedAt
    ) {
      throw new Error("The local workspace grant changed during authorization");
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
    if (stored.version !== 2 || stored.grant.readiness !== "ready") {
      if (generation === this.generation)
        this.executionController.abort(
          "Explicit workspace regrant is required",
        );
      return invalidGrant(
        stored.grant,
        "Explicit workspace regrant is required",
      );
    }
    let ownedPin: LocalWorkspaceRootPin | undefined;
    let identityVerified = false;
    try {
      const canonicalPath = await validateSelectedDirectory(stored.path);
      await this.assertOutsideProtectedRoots(canonicalPath);
      const currentPin =
        pin ??
        (ownedPin = await this.openRootPin(canonicalPath, generation, signal));
      try {
        // Canonical parsing and exact native comparison happen before any Git invocation.
        const expected = parseNativeGitMetadataIdentity(
          stored.gitMetadataIdentity,
        );
        await this.assertIdentity(currentPin, expected);
        identityVerified = true;
      } catch {
        return await this.requireRegrant(
          stored,
          generation,
          "Workspace or Git metadata identity changed; explicit regrant is required",
        );
      }
      const { repoRoot, probe } = await this.readRepository(
        canonicalPath,
        generation,
        signal,
        currentPin,
      );
      if (repoRoot !== stored.path) {
        return await this.requireRegrant(
          stored,
          generation,
          "Authorized repository path changed; explicit regrant is required",
        );
      }
      try {
        await this.assertIdentity(
          currentPin,
          parseNativeGitMetadataIdentity(stored.gitMetadataIdentity),
        );
      } catch {
        return await this.requireRegrant(
          stored,
          generation,
          "Workspace or Git metadata identity changed; explicit regrant is required",
        );
      }
      await this.assertStoredGrantCurrent(stored, generation, signal);
      return buildGrant(
        repoRoot,
        probe,
        stored.grant.workspaceId,
        stored.grant,
      );
    } catch (error) {
      if (!identityVerified)
        return await this.requireRegrant(
          stored,
          generation,
          "Workspace identity is unavailable; explicit regrant is required",
        );
      return invalidGrant(
        stored.grant,
        "Authorized workspace is unavailable; explicit regrant may be required",
      );
    } finally {
      if (ownedPin && !ownedPin.quarantined) await ownedPin.close();
    }
  }

  private async inspectIdentity(
    pin: LocalWorkspaceRootPin,
  ): Promise<NativeGitMetadataIdentity> {
    pin.assertCurrent();
    const inspector = this.createMetadataInspector?.(
      pin.rootDirectory,
      pin.observeNativeExecution,
    );
    if (!inspector)
      throw new Error(
        "Canonical native Git metadata identity inspection is unavailable",
      );
    const identity = parseNativeGitMetadataIdentity(
      await inspector.inspectGitMetadataIdentity({ signal: pin.signal }),
    );
    await pin.assertPathCurrent();
    return identity;
  }

  private async assertIdentity(
    pin: LocalWorkspaceRootPin,
    expected: NativeGitMetadataIdentity,
  ): Promise<void> {
    if ((await this.inspectIdentity(pin)) !== expected)
      throw new Error("Workspace or Git metadata identity changed");
  }

  private async requireRegrant(
    stored: Extract<StoredLocalWorkspaceGrant, { version: 2 }>,
    generation: number,
    reason: string,
  ): Promise<LocalWorkspaceGrant> {
    const invalid = invalidGrant(stored.grant, reason);
    if (generation === this.generation) {
      // Do not close old pins: authorized settlement retains its original directory object.
      this.executionController.abort(reason);
      await this.workspaceGrants.write({ ...stored, grant: invalid });
    }
    return invalid;
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
  workspaceId: WorkspaceId,
  previous: LocalWorkspaceGrant | null = null,
): LocalWorkspaceGrant {
  return LocalWorkspaceGrantSchema.parse({
    workspaceId,
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
