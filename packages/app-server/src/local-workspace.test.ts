import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { GitRepositoryProbeResult } from "@repo/git-service";
import { LocalPersistence } from "@repo/event-store/local";

import { LocalWorkspaceService } from "./local-workspace.js";

class FakeGitService {
  constructor(private readonly repositoryRoot: string) {}

  async probeRepository({ workspaceRoot }: { workspaceRoot: string }): Promise<GitRepositoryProbeResult> {
    return {
      repositoryRoot: this.repositoryRoot,
      repositoryIdentity: "github.com/example/repository",
      branch: workspaceRoot === this.repositoryRoot ? "main" : null,
      isDirty: false,
    };
  }
}

describe("LocalWorkspaceService", () => {
  it("persists a root grant and reopens it with a fresh Git probe", async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), "legioncode-grant-"));
    const repositoryRoot = join(storageDirectory, "repository");
    await mkdir(repositoryRoot);
    const gitService = new FakeGitService(await realpath(repositoryRoot));
    let persistence: LocalPersistence | undefined;

    try {
      persistence = new LocalPersistence({ storageDirectory });
      const service = new LocalWorkspaceService({ workspaceGrants: persistence.workspaceGrants, gitService });
      const granted = await service.grant({ path: repositoryRoot });
      expect(granted).toMatchObject({
        displayName: "repository",
        branch: "main",
        readiness: "ready",
      });
      persistence.close();
      persistence = new LocalPersistence({ storageDirectory });
      const reopened = await new LocalWorkspaceService({
        workspaceGrants: persistence.workspaceGrants,
        gitService: new FakeGitService(await realpath(repositoryRoot)),
      }).getCurrent();
      expect(reopened).toMatchObject({ workspaceId: granted.workspaceId, readiness: "ready" });

      const reopenedService = new LocalWorkspaceService({ workspaceGrants: persistence.workspaceGrants });
      await reopenedService.revoke();
      await expect(reopenedService.getCurrent()).resolves.toBeNull();
    } finally {
      persistence?.close();
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });

  it("rejects nested workspace selections", async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), "legioncode-grant-"));
    const repositoryRoot = join(storageDirectory, "repository");
    const nestedDirectory = join(repositoryRoot, "nested");
    await mkdir(nestedDirectory, { recursive: true });
    const gitService = new FakeGitService(await realpath(repositoryRoot));
    const persistence = new LocalPersistence({ storageDirectory });

    try {
      const service = new LocalWorkspaceService({ workspaceGrants: persistence.workspaceGrants, gitService });
      await expect(service.grant({ path: nestedDirectory })).rejects.toThrow(
        "repository root",
      );
    } finally {
      persistence.close();
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });
});
