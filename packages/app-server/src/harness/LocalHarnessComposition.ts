import { createHarnessHost, type HarnessHost } from "@repo/harness-core/server";
import type { LocalPersistence } from "@repo/event-store/local";
import type { StoredLocalWorkspaceGrant } from "@repo/event-store/local";
import type { ThreadId } from "@repo/platform-protocol";

import { LocalProviderService } from "../local-providers.js";
import { LocalThreadService } from "../local-threads.js";
import { LocalWorkspaceService } from "../local-workspace.js";

type HostConfiguration = Omit<Parameters<typeof createHarnessHost>[0], "workspaceRoot">;

/** Node-only local composition. Persistence remains the process's single SQLite writer. */
export class LocalHarnessComposition {
  readonly workspaceService: LocalWorkspaceService;
  readonly threadService: LocalThreadService;
  readonly providerService: LocalProviderService;

  constructor(persistence: LocalPersistence) {
    this.workspaceService = new LocalWorkspaceService({ workspaceGrants: persistence.workspaceGrants });
    this.threadService = new LocalThreadService({
      events: persistence.events,
      getWorkspace: () => this.workspaceService.getCurrent(),
    });
    this.providerService = new LocalProviderService({ selectionStore: persistence.providerSelection });
  }

  /** Host setup is private plumbing, not admission or permission to start a Turn.
   * The delegated runtime must first freeze/claim selection, lease and start evidence.
   * The caller supplies the selected credential environment and an enforcing OS policy;
   * there is deliberately no unrestricted process-launch default here.
   */
  async createHost(threadId: ThreadId, configuration: HostConfiguration): Promise<HarnessHost> {
    const thread = await this.threadService.get(threadId);
    const grant = await this.workspaceService.requireExecutionGrant(thread.workspaceId);
    const launchPolicy = configuration.launchPolicy;
    return createHarnessHost({
      ...configuration,
      workspaceRoot: grant.path,
      launchPolicy: {
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
