import { DefaultGitService } from "@repo/git-service";
import type { LocalPersistence } from "@repo/event-store/local";
import type { RuntimeGitSnapshotPort } from "@repo/runtime-kernel";
import type { LocalWorkspaceService } from "../local-workspace.js";
import { createNodeGitExecutor } from "../local-node-git-executor.js";
import type { LocalThreadService } from "../local-threads.js";

/** Root authorization surrounds the existing canonical Git snapshot implementation. */
export class LocalGitSnapshots implements RuntimeGitSnapshotPort {
  private readonly git = new DefaultGitService(createNodeGitExecutor());
  constructor(private readonly persistence: LocalPersistence, private readonly workspace: LocalWorkspaceService,
    private readonly threads: LocalThreadService) {}
  async captureSnapshot(input: Parameters<RuntimeGitSnapshotPort["captureSnapshot"]>[0]) {
    await this.authorize(input.workspace);
    const snapshot = await this.git.captureSnapshot(input);
    return { ...snapshot, runId: input.workspace.runId };
  }
  async getSnapshotDiff(input: Parameters<RuntimeGitSnapshotPort["getSnapshotDiff"]>[0]) {
    await this.authorize(input.workspace);
    return this.git.getSnapshotDiff(input);
  }
  private async authorize(input: Parameters<RuntimeGitSnapshotPort["captureSnapshot"]>[0]["workspace"]): Promise<void> {
    const events = await this.persistence.events.listAll();
    const event = events.find((value) => value.type === "run.created" && value.payload.run.id === input.runId);
    if (!event || event.type !== "run.created") throw new Error("Local Git snapshot run is not admitted");
    await this.threads.get(event.payload.run.threadId);
    const grant = await this.workspace.requireExecutionGrant(event.payload.run.workspaceId);
    if (grant.path !== input.filesystemRoot) throw new Error("Local Git snapshot root does not match the workspace grant");
  }
}
