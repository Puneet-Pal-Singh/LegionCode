import {
  parseNativeGitMetadataIdentity,
  type NativeFilesystemBridge,
  type NativeFilesystemExecution,
  type NativeGitMetadataIdentity,
  type NativeGitMetadataLayout,
} from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
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
  type LocalWorkspaceProject,
  type WorkspaceId,
} from "@repo/platform-protocol";
import type { DefaultGitService } from "@repo/git-service";
import type { VerifiedMacGitOptions } from "./local-mac-git-execution.js";
import { LocalWorkspaceRootPin } from "./local-workspace-root-pin.js";
import { LocalWorkspaceMetadataResolver } from "./local-workspace-metadata-resolver.js";
import { workspaceGrantFailure, type LocalWorkspaceGrantStage } from "./local-workspace-grant-error.js";

export type LocalWorkspaceServiceOptions = {
  workspaceGrants: LocalPersistence["workspaceGrants"];
  /** Trusted host storage/app/helper locations; never workspace request fields. */
  protectedHostRoots?: readonly string[];
  gitService?: Pick<DefaultGitService, "probeRepository">;
  createMetadataInspector?: (
    rootDirectory: FileHandle,
    observeExecution: (execution: NativeFilesystemExecution) => void,
  ) => Pick<NativeFilesystemBridge, "inspectGitMetadataLayout">;
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
  /** Same original pin, private layout only. Call inside its writer lease loan.
   * Settlement supplies its retained signal and actual native-resource observer. */
  readonly inspectMetadataLayout: (input: {
    readonly signal: AbortSignal;
    readonly observeExecution: (execution: NativeFilesystemExecution) => void;
    readonly purpose?: "association" | "mutation";
  }) => Promise<NativeGitMetadataLayout>;
  /** Same held-pin loan; pass the Turn signal as its third argument. */
  readonly withRootAuthority: LocalWorkspaceRootPin["withRootAuthority"];
  /** Call only after all execution/capture children and pipes have quiesced. */
  close(): Promise<void>;
  readonly generation: number;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Retained authority only for authorized final settlement of the same admitted scope. */
  assertSettlementCurrent(): void;
}

type WorkspaceGeneration = {
  readonly value: number;
  readonly controller: AbortController;
  current: boolean;
};

export class LocalWorkspaceService {
  private readonly generations = new Map<WorkspaceId, WorkspaceGeneration>();
  private mutationSequence = 0;
  private readonly revokedAt = new Map<WorkspaceId, number>();
  private acquisition: WorkspaceGeneration = { value: 0, controller: new AbortController(), current: true };
  private readonly metadataResolver: LocalWorkspaceMetadataResolver;
  private readonly workspaceGrants: LocalWorkspaceServiceOptions["workspaceGrants"];
  private readonly gitService: LocalWorkspaceServiceOptions["gitService"];
  private readonly createProbeService: LocalWorkspaceServiceOptions["createProbeService"];
  // Strong references are intentional: unknown physical closure must not let GC close/reuse an FD.
  private readonly quarantinedPins = new Set<LocalWorkspaceRootPin>();
  private readonly quarantinedHandles = new Set<FileHandle>();

  /** Physical ownership only: a failed close never becomes release evidence. */
  get hasUnsettledResources(): boolean {
    return this.quarantinedPins.size > 0 || this.quarantinedHandles.size > 0;
  }

  constructor(options: LocalWorkspaceServiceOptions) {
    this.workspaceGrants = options.workspaceGrants;
    this.metadataResolver = new LocalWorkspaceMetadataResolver({
      protectedHostRoots: options.protectedHostRoots ?? [],
      createInspector: options.createMetadataInspector,
    });
    if (options.gitService && options.createProbeService)
      throw new Error("Repository probe owner must be explicit");
    this.gitService = options.gitService;
    this.createProbeService = options.createProbeService;
  }

  async getCurrent(): Promise<LocalWorkspaceGrant | null> {
    return this.getCurrentGrant("git");
  }

  /** Fresh physical authorization for Thread metadata, not a Git readiness projection. */
  async getAuthorizedCurrent(): Promise<LocalWorkspaceGrant | null> {
    return this.getCurrentGrant("physical");
  }

  async getAuthorized(workspaceId: WorkspaceId): Promise<LocalWorkspaceGrant | null> {
    return this.getGrant(WorkspaceIdSchema.parse(workspaceId), "physical");
  }

  async list(): Promise<readonly LocalWorkspaceGrant[]> {
    return (await this.workspaceGrants.list()).map((stored) => stored.version === 2
      ? stored.grant
      : invalidGrant(stored.grant, "Explicit workspace regrant is required"));
  }

  async select(workspaceId: WorkspaceId): Promise<LocalWorkspaceGrant> {
    const id = WorkspaceIdSchema.parse(workspaceId);
    const generation = this.generationFor(id);
    const grant = await this.getGrant(id, "git");
    this.assertGeneration(generation);
    if (!grant || grant.readiness !== "ready") throw new Error("Workspace requires explicit regrant");
    await this.workspaceGrants.select(id);
    this.assertGeneration(generation);
    generation.controller.signal.throwIfAborted();
    return grant;
  }

  private async getCurrentGrant(projection: "physical" | "git"): Promise<LocalWorkspaceGrant | null> {
    const stored = await this.workspaceGrants.read();
    return stored ? this.getGrant(stored.grant.workspaceId, projection) : null;
  }

  private async getGrant(workspaceId: WorkspaceId, projection: "physical" | "git"): Promise<LocalWorkspaceGrant | null> {
    const generation = this.generationFor(workspaceId);
    const signal = generation.controller.signal;
    const stored = await this.workspaceGrants.read(workspaceId);
    if (!stored || !generation.current) return null;
    if (stored.version !== 2 || stored.grant.readiness !== "ready") {
      generation.controller.abort("Explicit workspace regrant is required");
      return invalidGrant(stored.grant, "Explicit workspace regrant is required");
    }
    this.assertProbingAvailable();
    const grant = await this.verifyStoredGrant(stored, generation, signal, undefined, projection);
    if (!generation.current) return null;
    this.assertProbingAvailable();
    if (grant.readiness !== "ready") return grant;
    signal.throwIfAborted();
    await this.workspaceGrants.rememberValidatedCurrent({ ...stored, grant });
    this.assertGeneration(generation);
    signal.throwIfAborted();
    return grant;
  }

  /** Path-free navigation records never authorize execution. */
  async listProjects(legacyWorkspaceIds: readonly WorkspaceId[]): Promise<{
    projects: LocalWorkspaceProject[]; selectedWorkspaceId: WorkspaceId | null;
  }> {
    const current = await this.workspaceGrants.read();
    const retained = await this.workspaceGrants.list();
    await this.workspaceGrants.rememberUnlinked([...legacyWorkspaceIds, ...retained.map((value) => value.grant.workspaceId)]);
    return { projects: await this.workspaceGrants.listProjects(), selectedWorkspaceId: current?.grant.workspaceId ?? null };
  }

  /** Forget navigation after revoking only this project's physical authority. */
  async forgetProject(workspaceId: WorkspaceId): Promise<void> {
    const id = WorkspaceIdSchema.parse(workspaceId);
    await this.revoke(id);
    await this.workspaceGrants.hideProject(id);
  }

  async grant(input: unknown): Promise<LocalWorkspaceGrant> {
    let stage: LocalWorkspaceGrantStage = "validation";
    try {
      this.assertProbingAvailable();
      const { path } = GrantLocalWorkspaceRequestSchema.parse(input);
      const startedAt = this.mutationSequence;
      const generation = this.invalidateAcquisition();
      const signal = generation.controller.signal;
      let pin: LocalWorkspaceRootPin | undefined;
      try {
        const canonicalPath = await validateSelectedDirectory(path);
        stage = "protected_roots";
        await this.assertOutsideProtectedRoots(canonicalPath);
        stage = "root_pin";
        pin = await this.openRootPin(canonicalPath, generation, signal);
        // Identity inspection is native metadata I/O, and precedes even Git readiness execution.
        stage = "metadata";
        const gitMetadataIdentity = await this.inspectIdentity(pin);
        stage = "git_probe";
        const { repoRoot, probe } = await this.readRepository(
          canonicalPath,
          generation,
          signal,
          pin,
        );
        if (repoRoot !== canonicalPath)
          throw new Error("Workspace selection must be the repository root");
        stage = "identity";
        await this.assertIdentity(pin, gitMetadataIdentity);
        stage = "persistence";
        const previous = (await this.workspaceGrants.list()).find((value) =>
          value.version === 2 && value.gitMetadataIdentity === gitMetadataIdentity);
        this.assertGeneration(generation);
        const knownWorkspaceId = await this.workspaceGrants.findKnownWorkspaceId(gitMetadataIdentity);
        this.assertGeneration(generation);
        const workspaceId = previous?.grant.workspaceId ?? knownWorkspaceId ?? WorkspaceIdSchema.parse(
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
        if ((this.revokedAt.get(workspaceId) ?? 0) > startedAt)
          throw new Error("Workspace was revoked during grant acquisition");
        this.invalidateExecutionBindings(workspaceId);
        const publishedGeneration = this.generationFor(workspaceId);
        await this.workspaceGrants.write(stored);
        stage = "final_validation";
        await pin.assertPathCurrent();
        this.assertGeneration(publishedGeneration);
        publishedGeneration.controller.signal.throwIfAborted();
        this.assertGeneration(generation);
        this.assertProbingAvailable();
        signal.throwIfAborted();
        return grant;
      } finally {
        try {
          if (pin && !pin.quarantined) await pin.close();
        } catch (error) {
          throw workspaceGrantFailure(error, "cleanup");
        }
      }
    } catch (error) {
      throw workspaceGrantFailure(error, stage);
    }
  }

  async revoke(workspaceId?: WorkspaceId): Promise<void> {
    if (workspaceId !== undefined) {
      const id = WorkspaceIdSchema.parse(workspaceId);
      this.revokedAt.set(id, ++this.mutationSequence);
      this.invalidateExecutionBindings(id);
      await this.workspaceGrants.clear(id);
      return;
    }
    const stored = await this.workspaceGrants.read();
    if (!stored) return;
    this.revokedAt.set(stored.grant.workspaceId, ++this.mutationSequence);
    this.invalidateExecutionBindings(stored.grant.workspaceId);
    await this.workspaceGrants.clear(stored.grant.workspaceId);
  }

  async bindForExecution(
    workspaceId: WorkspaceId,
  ): Promise<LocalWorkspaceExecutionBinding> {
    this.assertProbingAvailable();
    const generation = this.generationFor(workspaceId);
    const signal = generation.controller.signal;
    const stored = await this.workspaceGrants.read(workspaceId);
    this.assertGeneration(generation);
    if (!stored || stored.grant.workspaceId !== workspaceId) {
      throw new Error("Workspace is not granted for local execution");
    }
    if (stored.version !== 2 || stored.grant.readiness !== "ready") {
      generation.controller.abort("Explicit workspace regrant is required");
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
      const workspace = await this.verifyStoredGrant(
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
        inspectMetadataLayout: async (input: {
          signal: AbortSignal;
          observeExecution: (execution: NativeFilesystemExecution) => void;
          purpose?: "association" | "mutation";
        }) => {
          pin.assertSettlementCurrent();
          const layout = await this.metadataResolver.inspect({
            rootDirectory: pin.rootDirectory,
            signal: input.signal,
            observeExecution: input.observeExecution,
            purpose: input.purpose,
          });
          pin.assertSettlementCurrent();
          if (layout.identity !== metadataIdentity)
            throw new Error("Retained Git metadata identity changed");
          return layout;
        },
        withRootAuthority: pin.withRootAuthority,
        generation: generation.value,
        signal,
        close: () => pin.close(),
        assertSettlementCurrent: () => pin.assertSettlementCurrent(),
        assertCurrent: () => {
          pin.assertCurrent();
          this.assertGeneration(generation);
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
    const generation = this.generationFor(workspaceId);
    const signal = generation.controller.signal;
    const stored = await this.workspaceGrants.read(workspaceId);
    this.assertGeneration(generation);
    if (
      !stored ||
      stored.version !== 2 ||
      stored.grant.workspaceId !== workspaceId
    ) {
      if (stored?.version === 1)
        generation.controller.abort(
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
    generation: WorkspaceGeneration,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.workspaceGrants.read(stored.grant.workspaceId);
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

  private generationFor(workspaceId: WorkspaceId): WorkspaceGeneration {
    let generation = this.generations.get(workspaceId);
    if (!generation) {
      generation = { value: 0, controller: new AbortController(), current: true };
      this.generations.set(workspaceId, generation);
    }
    return generation;
  }

  private invalidateExecutionBindings(workspaceId: WorkspaceId): void {
    const previous = this.generationFor(workspaceId);
    previous.current = false;
    previous.controller.abort("Local workspace grant changed");
    this.generations.set(workspaceId, { value: previous.value + 1, controller: new AbortController(), current: true });
  }

  private invalidateAcquisition(): WorkspaceGeneration {
    this.acquisition.current = false;
    this.acquisition.controller.abort("Local workspace acquisition changed");
    return this.acquisition = { value: this.acquisition.value + 1, controller: new AbortController(), current: true };
  }

  private abortAllBindings(reason: string): void {
    this.acquisition.controller.abort(reason);
    for (const generation of this.generations.values()) generation.controller.abort(reason);
  }

  private assertGeneration(generation: WorkspaceGeneration): void {
    if (!generation.current) throw new Error("Local workspace grant changed during the operation");
  }

  private async verifyStoredGrant(
    stored: StoredLocalWorkspaceGrant,
    generation: WorkspaceGeneration,
    signal: AbortSignal,
    pin?: LocalWorkspaceRootPin,
    projection: "physical" | "git" = "git",
  ): Promise<LocalWorkspaceGrant> {
    if (stored.version !== 2 || stored.grant.readiness !== "ready") {
      if (generation.current)
        generation.controller.abort(
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
      // Physical scope is witnessed afresh above; branch/config/status are a
      // separate public projection and do not authorize Thread metadata writes.
      let grant = stored.grant;
      if (projection === "git") {
        const { repoRoot, probe } = await this.readRepository(
          canonicalPath, generation, signal, currentPin,
        );
        if (repoRoot !== stored.path) {
          return await this.requireRegrant(
            stored, generation,
            "Authorized repository path changed; explicit regrant is required",
          );
        }
        grant = buildGrant(repoRoot, probe, stored.grant.workspaceId, stored.grant);
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
      return grant;
    } catch {
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
    const layout = await this.metadataResolver.inspect({
      rootDirectory: pin.rootDirectory,
      signal: pin.signal,
      observeExecution: pin.observeNativeExecution,
    });
    const identity = layout.identity;
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
    generation: WorkspaceGeneration,
    reason: string,
  ): Promise<LocalWorkspaceGrant> {
    const invalid = invalidGrant(stored.grant, reason);
    if (generation.current) {
      // Do not close old pins: authorized settlement retains its original directory object.
      generation.controller.abort(reason);
      await this.workspaceGrants.write({ ...stored, grant: invalid }, false);
    }
    return invalid;
  }

  private async assertOutsideProtectedRoots(workspaceRoot: string): Promise<void> {
    await this.metadataResolver.assertOutsideProtectedRoots(workspaceRoot);
  }

  private assertProbingAvailable(): void {
    if (this.hasUnsettledResources) throw new Error("Repository probing is quarantined until host restart");
  }

  private async openRootPin(path: string, generation: WorkspaceGeneration, signal: AbortSignal): Promise<LocalWorkspaceRootPin> {
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
          this.abortAllBindings("Repository probe closure was not proved");
        });
      await pin.assertPathCurrent();
      return pin;
    } catch (error) {
      if (pin) {
        if (!pin.quarantined) await pin.close();
      } else {
        try { await rootDirectory.close(); }
        catch (closeError) {
          this.quarantinedHandles.add(rootDirectory);
          this.abortAllBindings("Workspace descriptor closure was not proved");
          throw closeError;
        }
      }
      throw error;
    }
  }

  private async readRepository(path: string, generation: WorkspaceGeneration, signal: AbortSignal, suppliedPin?: LocalWorkspaceRootPin) {
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
