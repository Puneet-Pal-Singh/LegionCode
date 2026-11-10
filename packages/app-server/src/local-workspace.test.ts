import {
  lstat, mkdtemp, mkdir, realpath, rm, writeFile, type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { DefaultGitService, type GitRepositoryProbeResult } from "@repo/git-service";
import { createNodeGitExecutor } from "./local-node-git-executor.js";
import { LocalPersistence } from "@repo/event-store/local";
import { WorkspaceIdSchema } from "@repo/platform-protocol";

import { LocalWorkspaceService } from "./local-workspace.js";

// Unit port only: native helper/closure acceptance is exercised by the owned
// real grant/capture proof, rather than inferred from this filesystem fixture.
function createMetadataInspector(repositoryRoot: string) {
  return (rootDirectory: FileHandle) => ({
    async inspectGitMetadataLayout() {
      const gitDirectory = join(repositoryRoot, ".git");
      const identities = await Promise.all([
        rootDirectory.stat({ bigint: true }),
        lstat(gitDirectory, { bigint: true }),
      ]);
      const fields = identities.flatMap((identity) => [
        identity.dev,
        identity.ino,
        0n,
        0n,
      ]);
      return {
        kind: "ordinary" as const,
        gitDirectory,
        commonDirectory: gitDirectory,
        backlinkPath: null,
        identity: `gitdir-v1:${fields.map((value) => value.toString(16)).join(":")}`,
      };
    },
  });
}

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
    await mkdir(join(repositoryRoot, ".git"));
    const gitService = new FakeGitService(await realpath(repositoryRoot));
    const inspectMetadata = createMetadataInspector(await realpath(repositoryRoot));
    let persistence: LocalPersistence | undefined;

    try {
      persistence = new LocalPersistence({ storageDirectory });
      const service = new LocalWorkspaceService({
        workspaceGrants: persistence.workspaceGrants,
        gitService,
        createMetadataInspector: inspectMetadata,
      });
      const granted = await service.grant({ path: repositoryRoot });
      expect(granted).toMatchObject({
        displayName: "repository",
        branch: "main",
        readiness: "ready",
      });
      await expect(service.requireExecutionGrant(granted.workspaceId)).resolves.toMatchObject({
        path: await realpath(repositoryRoot),
        grant: { workspaceId: granted.workspaceId, readiness: "ready" },
      });
      await expect(service.requireExecutionGrant(WorkspaceIdSchema.parse("wrk_otherworkspace")))
        .rejects.toThrow("regrant");

      const revokingService = new LocalWorkspaceService({
        workspaceGrants: persistence.workspaceGrants,
        createMetadataInspector: inspectMetadata,
        gitService: {
          probeRepository: async (input) => {
            await service.revoke();
            return gitService.probeRepository(input);
          },
        },
      });
      await expect(revokingService.requireExecutionGrant(granted.workspaceId))
        .rejects.toThrow("regrant");
      await service.grant({ path: repositoryRoot });
      persistence.close();
      persistence = new LocalPersistence({ storageDirectory });
      const reopened = await new LocalWorkspaceService({
        workspaceGrants: persistence.workspaceGrants,
        gitService: new FakeGitService(await realpath(repositoryRoot)),
        createMetadataInspector: inspectMetadata,
      }).getCurrent();
      expect(reopened).toMatchObject({ workspaceId: granted.workspaceId, readiness: "ready" });

      const reopenedService = new LocalWorkspaceService({ workspaceGrants: persistence.workspaceGrants });
      await reopenedService.revoke();
      await expect(reopenedService.getCurrent()).resolves.toBeNull();
      await expect(reopenedService.requireExecutionGrant(granted.workspaceId))
        .rejects.toThrow("regrant");

      // The production local host executor supports unborn repositories and new
      // files through the same atomic index transaction as the Sandbox adapter.
      const executor = createNodeGitExecutor();
      expect((await executor.execute({ cwd: repositoryRoot, args: ["init", "-b", "main"] })).exitCode).toBe(0);
      await writeFile(join(repositoryRoot, "new.txt"), "new local content\n");
      const committed = await new DefaultGitService(executor).commit({
        workspace: { runId: "run_localgitproof", filesystemRoot: repositoryRoot },
        paths: ["new.txt"], message: "initial local file",
        author: { name: "Local proof", email: "local@example.com" },
      });
      expect(committed.branchName).toBe("main");
      expect(committed.commitSha).toMatch(/^[a-f0-9]{40,64}$/);
      expect((await executor.execute({ cwd: repositoryRoot, args: ["status", "--porcelain"] })).stdout).toBe("");
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
    await mkdir(join(repositoryRoot, ".git"));
    const gitService = new FakeGitService(await realpath(repositoryRoot));
    const persistence = new LocalPersistence({ storageDirectory });

    try {
      const service = new LocalWorkspaceService({
        workspaceGrants: persistence.workspaceGrants,
        gitService,
        createMetadataInspector: createMetadataInspector(await realpath(repositoryRoot)),
      });
      await expect(service.grant({ path: nestedDirectory })).rejects.toThrow(
        "repository root",
      );
    } finally {
      persistence.close();
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });
});
