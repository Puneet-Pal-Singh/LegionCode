import { createHarnessHost, HarnessExecutionPort, HarnessRegistry, HarnessSessionManager, type HarnessDriver, type HarnessInstance, type HarnessInstanceScope, type HarnessHost } from "@repo/harness-core/server";
import type { LocalPersistence } from "@repo/event-store/local";
import type { StoredLocalWorkspaceGrant } from "@repo/event-store/local";
import type { ReplayLifecycleEventsRequest, ThreadId } from "@repo/platform-protocol";
import { AppServerOperationError } from "../server.js";

import { LocalProviderService } from "../local-providers.js";
import { LocalThreadNotFoundError, LocalThreadService } from "../local-threads.js";
import { LocalWorkspaceService } from "../local-workspace.js";

type HostConfiguration = Omit<Parameters<typeof createHarnessHost>[0], "workspaceRoot">;

/** Node-only local composition. Persistence remains the process's single SQLite writer. */
export class LocalHarnessComposition {
  readonly workspaceService: LocalWorkspaceService;
  readonly threadService: LocalThreadService;
  readonly providerService: LocalProviderService;
  private readonly registry = new HarnessRegistry();
  readonly harnessExecution = new HarnessExecutionPort(new HarnessSessionManager(this.registry));

  constructor(private readonly persistence: LocalPersistence) {
    this.workspaceService = new LocalWorkspaceService({ workspaceGrants: persistence.workspaceGrants });
    this.threadService = new LocalThreadService({
      events: persistence.events,
      getWorkspace: () => this.workspaceService.getCurrent(),
    });
    this.providerService = new LocalProviderService({ selectionStore: persistence.providerSelection });
  }

  /** Reuses reviewed local replay authorization from PR617; no second event feed. */
  async replayLifecycleEvents(params: ReplayLifecycleEventsRequest) {
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

  /** Trusted local setup only. Runtime must durably admit/claim before opening this port. */
  registerInstance(
    scope: HarnessInstanceScope,
    driver: HarnessDriver,
    configureHost: (command: Parameters<HarnessInstance["createHost"]>[0]) => Promise<HostConfiguration>,
  ): void {
    this.registry.register({
      scope,
      driver,
      createHost: async (command) => {
        const selection = command.selection;
        const admission = await this.persistence.turnAdmissions.getByTurn(selection.turnId);
        if (!admission || admission.run.id !== selection.runId ||
            admission.run.threadId !== selection.threadId || admission.run.userId !== selection.userId ||
            admission.run.workspaceId !== selection.workspaceId || admission.run.modelId !== selection.modelId ||
            admission.runAttemptId !== selection.runAttemptId || admission.turn.id !== selection.turnId) {
          throw new Error("Harness execution does not match a canonical local Turn admission");
        }
        const thread = await this.threadService.get(command.selection.threadId);
        if (thread.userId !== command.selection.userId || thread.workspaceId !== command.selection.workspaceId) {
          throw new Error("Harness selection does not match the authorized local thread");
        }
        const grant = await this.workspaceService.requireExecutionGrant(thread.workspaceId);
        if (grant.path !== command.filesystemRoot) {
          throw new Error("Harness execution root does not match the local workspace grant");
        }
        // Resolve the selected instance's protected environment only after local scope checks.
        return this.createGrantedHost(thread.id, grant, await configureHost(command));
      },
    });
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
    if (current.path !== expected.path ||
        current.grant.workspaceId !== expected.grant.workspaceId ||
        current.grant.grantedAt !== expected.grant.grantedAt) {
      throw new Error("The local workspace grant changed before process launch");
    }
  }
}
