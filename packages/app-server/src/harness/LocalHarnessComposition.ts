import { createHarnessHost, HarnessExecutionPort, HarnessRegistry, HarnessSessionManager, type HarnessDriver, type HarnessInstance, type HarnessInstanceScope, type HarnessHost } from "@repo/harness-core/server";
import { fingerprintHarnessCommand, HarnessStartCommandSchema } from "@repo/harness-core/server";
import { CodexDriver } from "@repo/harness-codex/server";
import { ClaudeDriver } from "@repo/harness-claude/server";
import { OpenCodeV2Driver } from "@repo/harness-opencode/server";
import { RuntimeKernel, type RuntimeKernelDependencies, type DelegatedExecutionDependencies } from "@repo/runtime-kernel";
import type { LocalPersistence } from "@repo/event-store/local";
import type { StoredLocalWorkspaceGrant } from "@repo/event-store/local";
import { HarnessSelectionSchema, type HarnessSelection, type ReplayLifecycleEventsRequest, type ReplayLifecycleEventsResponse, type ThreadId } from "@repo/platform-protocol";
import { AppServerOperationError } from "../server.js";
import { LocalHarnessOperations } from "./LocalHarnessOperations.js";
import { LocalWorkspaceLease } from "./LocalWorkspaceLease.js";
import { LocalGitSnapshots } from "./LocalGitSnapshots.js";
import { LocalTurnArtifacts } from "./LocalTurnArtifacts.js";
import { LocalTurnService, type LocalHarnessRuntimeServices, type LocalHarnessRuntimeBinding } from "./LocalTurnService.js";
import { LocalHarnessExecution } from "./LocalHarnessExecution.js";
import { settleLocalHarnessAttachment } from "./LocalHarnessSettlement.js";

import type { LocalProviderService } from "../local-providers.js";
import { LocalThreadNotFoundError, type LocalThreadService } from "../local-threads.js";
import type { LocalWorkspaceService } from "../local-workspace.js";

// Private Node entry for the process owner; never a renderer/protocol export.
export type { LocalHarnessBackend, LocalHarnessInitializationResult } from "./LocalHarnessRestart.js";
export { LocalHarnessRecoveryError } from "./LocalTurnService.js";
export type { LocalHarnessShutdownResult } from "./LocalTurnService.js";

type HostConfiguration = Omit<Parameters<typeof createHarnessHost>[0], "workspaceRoot">;
type ConfigureHost = (command: Parameters<HarnessInstance["createHost"]>[0]) => Promise<HostConfiguration>;

/** Private Node bootstrap, constructed after the one local SQLite writer and
 * grant/lease owners exist. This callback never crosses HTTP or renderer IPC.
 */
export type LocalHarnessBootstrap = (context: {
  readonly persistence: LocalPersistence;
  readonly environmentId: string;
  readonly workspaceService: LocalWorkspaceService;
  readonly threadService: LocalThreadService;
  readonly leases: LocalWorkspaceLease;
  readonly providerService: LocalProviderService;
  readonly fenceConnection: (origin: Pick<HarnessInstanceScope, "connectionId" | "authOwnerGeneration">) => void;
}) => LocalHarnessRuntimeServices;

/** Node-only local composition. Persistence remains the process's single SQLite writer. */
export class LocalHarnessComposition {
  readonly environmentId: string;
  readonly workspaceService: LocalWorkspaceService;
  readonly threadService: LocalThreadService;
  readonly providerService: LocalProviderService;
  readonly harnessOperations: LocalHarnessOperations;
  readonly turnService: LocalTurnService;
  readonly gitSnapshots: LocalGitSnapshots;
  readonly leases: LocalWorkspaceLease;
  readonly artifacts: LocalTurnArtifacts | undefined;
  private runtimeServices: LocalHarnessRuntimeServices | undefined;
  private readonly configuredScopes: HarnessInstanceScope[] = [];
  private readonly registry = new HarnessRegistry();
  private readonly sessions = new HarnessSessionManager(this.registry);
  readonly harnessExecution = new HarnessExecutionPort(this.sessions);

  constructor(private readonly persistence: LocalPersistence, services: {
    readonly workspaceService: LocalWorkspaceService;
    readonly threadService: LocalThreadService;
    readonly providerService: LocalProviderService;
  }, storageDirectory?: string) {
    this.environmentId = persistence.environmentId;
    this.workspaceService = services.workspaceService;
    this.threadService = services.threadService;
    this.providerService = services.providerService;
    this.leases = new LocalWorkspaceLease(persistence, this.workspaceService,
      (turnId) => this.turnService.hasExecutionOwner(turnId));
    this.gitSnapshots = new LocalGitSnapshots(persistence, this.workspaceService, this.threadService);
    this.artifacts = storageDirectory ? new LocalTurnArtifacts(persistence, storageDirectory) : undefined;
    this.harnessOperations = new LocalHarnessOperations({
      environmentId: this.environmentId,
      workspaceService: this.workspaceService,
      threadService: this.threadService,
      controlPlane: persistence.createHarnessControlPlane(this.threadService.actorUserId),
    });
    this.turnService = new LocalTurnService({
      persistence, threads: this.threadService, workspace: this.workspaceService, leases: this.leases,
      harnessOperations: this.harnessOperations,
      settleExecution: (admission) => settleLocalHarnessAttachment({
        admission, persistence: this.persistence, leases: this.leases,
        releaseAfterCanonicalSettlement: (session) => this.harnessExecution.releaseAfterCanonicalSettlement(session),
      }),
      readDiff: async (turnId) => {
        if (!this.artifacts) throw new AppServerOperationError(503, "server_unavailable", "Local artifact storage is unavailable");
        return this.artifacts.readDiff(turnId);
      },
      resolveBinding: async (input) => {
        if (!this.runtimeServices) throw new AppServerOperationError(503, "server_unavailable",
          "Local credential, lease, artifact and enforced launch services are not available", "LOCAL_HARNESS_CAPABILITY_UNAVAILABLE", false);
        return this.runtimeServices.resolveBinding(input);
      },
      recoverExecution: (runtime, input) => this.harnessExecution.reconcilePriorGeneration({
        ...input,
        // Never accept a bootstrap-supplied certification callback. The runtime
        // restores canonical replay and confirms failed/interrupted settlement;
        // core separately requires the full physical fence and journal ACK drain.
        resolveObservationIntegrity: (origin) => runtime.resolveObservationIntegrity(origin),
      }),
      composeRuntime: (binding, prepared, selection) => {
        this.ensureSelectedDriver(binding);
        return this.createRuntime(prepared.dependencies, prepared.execution, selection);
      },
    });
  }

  /** Existing private utility-process bootstrap installs canonical local adapters. */
  bindRuntimeServices(services: LocalHarnessRuntimeServices): void {
    if (this.runtimeServices) throw new Error("Local runtime services are already bound");
    this.harnessOperations.bindServices(services.operations);
    this.runtimeServices = services;
  }

  bootstrap(factory: LocalHarnessBootstrap): void {
    this.bindRuntimeServices(factory({
      persistence: this.persistence, environmentId: this.environmentId,
      workspaceService: this.workspaceService, threadService: this.threadService,
      providerService: this.providerService, leases: this.leases,
      fenceConnection: this.fenceConnection.bind(this),
    }));
  }

  private ensureSelectedDriver(binding: LocalHarnessRuntimeBinding): void {
    const existing = this.configuredScopes.find((scope) => scope.instanceId === binding.scope.instanceId);
    if (existing) {
      if (Object.entries(existing).some(([key, value]) => binding.scope[key as keyof HarnessInstanceScope] !== value)) {
        throw new Error("Configured local instance changed after selection was frozen");
      }
      return;
    }
    if (binding.scope.harness === "codex") {
      if (!binding.codexExecutable) throw new Error("Selected Codex installation is unavailable");
      this.registerCodexInstance({ ...binding.scope, harness: "codex" }, binding.codexExecutable, binding.configureHost, {
        ...binding.codexOptions, policy: { id: binding.permissionProfileId, revision: binding.policyRevision },
      });
    } else if (binding.scope.harness === "claude") {
      this.registerInstance(binding.scope, new ClaudeDriver(), binding.configureHost);
    } else {
      if (!binding.openCodeOptions) throw new Error("OpenCode requires configured native policy and quiescence authorities");
      this.registerInstance(binding.scope, new OpenCodeV2Driver(binding.openCodeOptions), binding.configureHost);
    }
  }

  /** Reuses reviewed local replay authorization from PR617; no second event feed. */
  async replayLifecycleEvents(params: ReplayLifecycleEventsRequest): Promise<ReplayLifecycleEventsResponse> {
    if (params.backend && params.backend !== "execution-engine-v1") {
      throw new AppServerOperationError(400, "invalid_request", "Hosted execution backends are unavailable locally");
    }
    const first = await this.persistence.lifecycleEvents.replay({
      turnId: params.turnId, afterSequence: null, limit: 1,
    });
    const event = first.events[0];
    if (!event) throw new AppServerOperationError(404, "not_found", "Local turn was not found");
    try {
      await this.threadService.get(event.threadId);
    } catch (error) {
      if (error instanceof LocalThreadNotFoundError) {
        throw new AppServerOperationError(404, "not_found", "Local turn was not found in the granted workspace");
      }
      throw error;
    }
    return this.persistence.lifecycleEvents.replay({
      turnId: params.turnId,
      afterSequence: params.afterSequence ?? null,
      limit: params.limit ?? 1_000,
    });
  }

  /** The canonical kernel exclusively selects delegated versus native execution.
   * Observation recovery/commit/reply claims and lease/auth fencing must come from
   * the same local persistence and custody authorities; none has an in-memory default.
   */
  createRuntime(
    dependencies: Omit<RuntimeKernelDependencies, "lifecycleEvents" | "delegated">,
    execution: Omit<DelegatedExecutionDependencies, "harness" | "observations">,
    selection: HarnessSelection,
  ): RuntimeKernel {
    if (!this.artifacts) throw new AppServerOperationError(503, "server_unavailable", "Local immutable artifact storage is unavailable");
    return new RuntimeKernel({
      ...dependencies,
      gitSnapshots: this.gitSnapshots,
      turnArtifacts: this.artifacts,
      lifecycleEvents: this.persistence.lifecycleEvents,
      delegated: {
        ...execution,
        harness: new LocalHarnessExecution(this.persistence, this.harnessExecution),
        observations: this.persistence.createHarnessObservationCommitPort({
          userId: selection.userId, sessionId: selection.threadId, runId: selection.runId,
          workspaceId: selection.workspaceId, threadId: selection.threadId, turnId: selection.turnId,
          runAttemptId: selection.runAttemptId, selectionJson: JSON.stringify(selection),
        }),
        assertActive: async (input) => {
          await this.assertLocalExecution(input);
          await this.leases.assertActive(input);
          await execution.assertActive(input);
        },
      },
    });
  }

  /** Uses the final driver package unchanged. Its pinned platform/auth gates remain authoritative. */
  registerCodexInstance(
    scope: HarnessInstanceScope & { readonly harness: "codex" },
    executable: string,
    configureHost: ConfigureHost,
    options: NonNullable<ConstructorParameters<typeof CodexDriver>[1]>,
  ): void {
    if (!options.policy || !options.accountBinding || options.accountBinding.instanceId !== scope.instanceId ||
        options.accountBinding.connectionId !== scope.connectionId || options.accountBinding.authOwnerGeneration !== scope.authOwnerGeneration) {
      throw new Error("Codex requires trusted configured policy and preverified selected-account binding");
    }
    this.registerInstance(scope, new CodexDriver(executable, options), configureHost);
  }

  /** Trusted local setup only. Runtime must durably admit/claim before opening this port. */
  registerInstance(
    scope: HarnessInstanceScope,
    driver: HarnessDriver,
    configureHost: ConfigureHost,
  ): void {
    if (scope.environmentId !== this.environmentId) {
      throw new Error("A local harness instance cannot bind a different environment");
    }
    this.registry.register({
      scope,
      driver,
      openingAuthority: {
        reserve: async ({ command: rawCommand, host }) => {
          const command = HarnessStartCommandSchema.parse(rawCommand);
          const processGeneration = host.processGeneration;
          await this.assertLocalExecution(command);
          const selection = command.selection;
          const stored = { userId: selection.userId, sessionId: selection.threadId, runId: selection.runId,
            workspaceId: selection.workspaceId, threadId: selection.threadId, turnId: selection.turnId,
            runAttemptId: selection.runAttemptId, selectionJson: JSON.stringify(selection) };
          const intent = {
            openingRef: `${selection.runAttemptId}:${processGeneration}`, commandId: command.commandId,
            commandFingerprint: await fingerprintHarnessCommand(command), runAttemptId: selection.runAttemptId,
            instanceId: selection.instanceId, processGeneration,
            authOwnerGeneration: selection.authOwnerGeneration, workspaceGrantId: selection.workspaceGrantId,
            checkoutLeaseId: command.leaseId, startSnapshotId: command.startSnapshot.snapshotKey,
            executionLease: { kind: "local" as const, leaseId: command.leaseId },
          };
          const reserved = await this.persistence.harnessBindings.reserveOpening({ selection: stored, command, intent });
          if (reserved.status !== "reserved") throw new Error("Local opening requires explicit recovery");
          return {
            beginDispatch: async () => {
              await this.assertLocalExecution(command);
              await this.persistence.harnessBindings.beginOpeningDispatch({ selection: stored, intent });
            },
            cancelBeforeDispatch: async () => {
              const cancelled = await this.persistence.harnessBindings.cancelReservedOpening({selection: stored, intent});
              if (cancelled !== "cancelled_before_dispatch") throw new Error("Local opening dispatch is ambiguous; recovery required");
            },
            acknowledge: async (session) => {
              await this.persistence.harnessBindings.acknowledgeOpening({ selection: stored, intent,
                origin: { instanceId: session.instanceId, externalSessionId: session.externalSessionId,
                  processGeneration: session.processGeneration, authOwnerGeneration: selection.authOwnerGeneration } });
            },
          };
        },
      },
      createHost: async (command) => {
        const { thread, grant } = await this.assertLocalExecution(command);
        // Resolve the selected instance's protected environment only after local scope checks.
        return this.createGrantedHost(thread.id, grant, await configureHost(command));
      },
    });
    this.configuredScopes.push(Object.freeze({ ...scope }));
  }

  /** Private main/vault notification after durable revocation. Fence exactly the
   * originating generation; a late notification cannot revoke a newer connection.
   * Runtime still owns quiescence, terminal/artifact settlement and lease release.
   */
  fenceConnection(origin: Pick<HarnessInstanceScope, "connectionId" | "authOwnerGeneration">): void {
    for (let index = this.configuredScopes.length - 1; index >= 0; index -= 1) {
      const scope = this.configuredScopes[index]!;
      if (scope.connectionId === origin.connectionId && scope.authOwnerGeneration === origin.authOwnerGeneration) {
        this.sessions.fenceInstance(scope.instanceId);
        this.configuredScopes.splice(index, 1);
      }
    }
  }

  private async assertLocalExecution(input: Parameters<DelegatedExecutionDependencies["assertActive"]>[0]) {
    const selection = input.selection;
    const admission = await this.persistence.turnAdmissions.getByTurn(selection.turnId);
    if (!admission || admission.run.id !== selection.runId ||
        admission.run.threadId !== selection.threadId || admission.run.userId !== selection.userId ||
        admission.run.workspaceId !== selection.workspaceId || admission.run.modelId !== selection.modelId ||
        admission.run.permissionProfileId !== selection.policyId || admission.run.executionCapability === "conversation" ||
        admission.runAttemptId !== selection.runAttemptId || admission.turn.id !== selection.turnId) {
      throw new Error("Harness execution does not match a canonical local Turn admission");
    }
    const frozen = await this.persistence.harnessBindings.read({ userId: selection.userId,
      turnId: selection.turnId, runAttemptId: selection.runAttemptId });
    if (!frozen || JSON.stringify(HarnessSelectionSchema.parse(JSON.parse(frozen.selection.selectionJson) as unknown)) !==
        JSON.stringify(HarnessSelectionSchema.parse(selection))) {
      throw new Error("Local harness selection is not durably frozen for this attempt");
    }
    const thread = await this.threadService.get(selection.threadId);
    if (thread.status !== "active" || thread.userId !== selection.userId || thread.workspaceId !== selection.workspaceId) {
      throw new Error("Harness selection does not match the authorized local thread");
    }
    const grant = await this.workspaceService.requireExecutionGrant(thread.workspaceId);
    if (grant.path !== input.filesystemRoot) {
      throw new Error("Harness execution root does not match the local workspace grant");
    }
    return { thread, grant };
  }

  /** Host setup is private plumbing, not admission or permission to start a Turn.
   * The delegated runtime must first freeze/claim selection, lease and start evidence.
   * The caller supplies the selected credential environment and an enforcing OS policy;
   * there is deliberately no unrestricted process-launch default here.
   */
  async createHost(threadId: ThreadId, configuration: HostConfiguration): Promise<HarnessHost> {
    const thread = await this.threadService.get(threadId);
    const grant = await this.workspaceService.requireExecutionGrant(thread.workspaceId);
    return this.createGrantedHost(threadId, grant, configuration);
  }

  private async createGrantedHost(
    threadId: ThreadId,
    grant: StoredLocalWorkspaceGrant,
    configuration: HostConfiguration,
  ): Promise<HarnessHost> {
    const launchPolicy = configuration.launchPolicy;
    return createHarnessHost({
      ...configuration,
      workspaceRoot: grant.path,
      launchPolicy: {
        assertEnforced: async (boundary) => {
          if (boundary.workspaceRoot !== grant.path) {
            throw new Error("Harness policy root does not match the authorized local workspace");
          }
          await this.assertCurrentGrant(threadId, grant);
          return launchPolicy.assertEnforced(boundary);
        },
        launch: async (request) => {
          // A host may be prepared before its process starts. A later revoke,
          // workspace switch or grant replacement must fence that launch too.
          await this.assertCurrentGrant(threadId, grant);
          return launchPolicy.launch(request);
        },
      },
    });
  }

  private async assertCurrentGrant(threadId: ThreadId, expected: StoredLocalWorkspaceGrant): Promise<void> {
    const thread = await this.threadService.get(threadId);
    const current = await this.workspaceService.requireExecutionGrant(thread.workspaceId);
    if (thread.status !== "active" || current.path !== expected.path ||
        current.grant.workspaceId !== expected.grant.workspaceId ||
        current.grant.grantedAt !== expected.grant.grantedAt) {
      throw new Error("The local workspace grant changed before process launch");
    }
  }
}
