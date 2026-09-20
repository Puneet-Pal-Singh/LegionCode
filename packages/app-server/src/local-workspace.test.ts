import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { GitRepositoryProbeResult } from "@repo/git-service";

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

    try {
      const service = new LocalWorkspaceService({ storageDirectory, gitService });
      const granted = await service.grant({ path: repositoryRoot });
      expect(granted).toMatchObject({
        displayName: "repository",
        branch: "main",
        readiness: "ready",
      });
      expect(
        JSON.parse(
          await readFile(join(storageDirectory, "workspace-grant.json"), "utf8"),
        ),
      ).toMatchObject({ path: await realpath(repositoryRoot) });

      const reopened = await new LocalWorkspaceService({
        storageDirectory,
        gitService: new FakeGitService(await realpath(repositoryRoot)),
      }).getCurrent();
      expect(reopened).toMatchObject({ workspaceId: granted.workspaceId, readiness: "ready" });

      await service.revoke();
      await expect(service.getCurrent()).resolves.toBeNull();
    } finally {
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });

  it("rejects nested selections and surfaces corrupt durable state", async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), "legioncode-grant-"));
    const repositoryRoot = join(storageDirectory, "repository");
    const nestedDirectory = join(repositoryRoot, "nested");
    await mkdir(nestedDirectory, { recursive: true });
    const gitService = new FakeGitService(await realpath(repositoryRoot));

    try {
      const service = new LocalWorkspaceService({ storageDirectory, gitService });
      await expect(service.grant({ path: nestedDirectory })).rejects.toThrow(
        "repository root",
      );
      await writeFile(join(storageDirectory, "workspace-grant.json"), "not-json");
      await expect(service.getCurrent()).rejects.toThrow("corrupt");
    } finally {
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });
});
