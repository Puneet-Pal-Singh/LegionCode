import { describe, expect, it } from "vitest";
import { RepositoryIdentityConflictError } from "./types.js";
import { MemoryWorkspaceRepository } from "./MemoryWorkspaceRepository.js";

describe("MemoryWorkspaceRepository", () => {
  it("persists selected workspace state per user", async () => {
    const repository = new MemoryWorkspaceRepository();

    const selected = await repository.selectWorkspace(
      createSelectionInput("user-1", "main"),
    );
    const loaded = await repository.findWorkspaceSelection("user-1");

    expect(loaded).toEqual(selected);
    expect(loaded?.workspace.lastSelectedBranch).toBe("main");
    expect(loaded?.repository.fullName).toBe("acme/legioncode");
    const before = await repository.findWorkspaceConfiguration("user-1", selected.workspace.id);
    const conflicting = createSelectionInput("other-user", "must-not-select");
    for (const providerRepoId of ["456", null]) {
      await expect(repository.selectWorkspace({ ...conflicting, repository: { ...conflicting.repository, providerRepoId } })).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
      expect(await repository.findWorkspaceConfiguration("user-1", selected.workspace.id)).toEqual(before);
      expect(await repository.listWorkspaces("other-user")).toEqual([]);
      expect(await repository.findWorkspaceSelection("other-user")).toBeNull();
    }
    await repository.selectWorkspace(createSelectionInput("other-user", "main"));
    expect(await repository.findWorkspaceConfiguration("user-1", selected.workspace.id)).toEqual(before);
    // Detached egress cannot mutate canonical namespace identity or selection.
    selected.repository.providerRepoId = "456";
    loaded!.selection.selectedBranch = "external-mutation";
    const listed = await repository.listWorkspaces("user-1");
    listed[0]!.repository.providerRepoId = null;
    expect(await repository.findWorkspaceConfiguration("user-1", selected.workspace.id)).toEqual(before);
    expect((await repository.findWorkspaceSelection("user-1"))?.selection.selectedBranch).toBe("main");
    for (const legacyId of [null, "unknown"]) {
      const legacyInput = createSelectionInput("legacy-user", "main");
      const name = legacyId === null ? "legacy-null" : "legacy-unknown";
      const legacy = { ...legacyInput, repository: { ...legacyInput.repository, name, fullName: `acme/${name}`, providerRepoId: legacyId } };
      const seeded = await repository.selectWorkspace(legacy);
      const savedLegacy = await repository.findWorkspaceSelection("legacy-user");
      await expect(repository.selectWorkspace({ ...legacy, repository: { ...legacy.repository, providerRepoId: "123" } })).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
      await expect(repository.updateWorkspaceConfiguration({ userId: "legacy-user", workspaceId: seeded.workspace.id, expectedVersion: 1, expectedRepository: { id: seeded.repository.id, providerRepoId: "123" }, patch: { name: "blocked" }, now: legacy.now })).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
      expect(await repository.findWorkspaceSelection("legacy-user")).toEqual(savedLegacy);
    }
    const input = {
      userId: "user-1",
      workspaceId: selected.workspace.id,
      expectedVersion: 1,
      expectedRepository: { id: selected.repository.id, providerRepoId: "123" },
      patch: { name: "My workspace", selectedBranch: "feature/saved" },
      now: "2026-05-15T00:00:00.000Z",
    };
    await expect(repository.updateWorkspaceConfiguration({ ...input, expectedRepository: { ...input.expectedRepository, providerRepoId: "456" } })).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
    await expect(repository.updateWorkspaceConfiguration({ ...input, expectedRepository: { ...input.expectedRepository, id: "different-repo" } })).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
    const writes = await Promise.all([
      repository.updateWorkspaceConfiguration(input),
      repository.updateWorkspaceConfiguration({
        ...input,
        patch: { name: "stale" },
      }),
    ]);
    expect(writes.map((result) => result.status)).toEqual([
      "updated",
      "conflict",
    ]);
    expect(
      await repository.findWorkspaceConfiguration(
        "user-1",
        selected.workspace.id,
      ),
    ).toMatchObject({
      version: 2,
      workspace: { name: "My workspace", lastSelectedBranch: "feature/saved" },
    });
    expect(await repository.findWorkspaceSelection("user-1")).toMatchObject({
      selection: { selectedBranch: "feature/saved" },
    });
    const unchanged = await repository.updateWorkspaceConfiguration({
      ...input,
      expectedVersion: 2,
    });
    expect(unchanged).toMatchObject({
      status: "updated",
      configuration: { version: 2 },
    });
    expect(
      await repository.findWorkspaceConfiguration(
        "other-user",
        selected.workspace.id,
      ),
    ).toBeNull();
    expect(
      await repository.updateWorkspaceConfiguration({
        ...input,
        userId: "other-user",
      }),
    ).toEqual({ status: "not_found" });
  });

  it("updates existing workspace selection without duplicating list entries", async () => {
    const repository = new MemoryWorkspaceRepository();

    await repository.selectWorkspace(createSelectionInput("user-1", "main"));
    const selected = await repository.selectWorkspace(
      createSelectionInput("user-1", "dev"),
    );
    const workspaces = await repository.listWorkspaces("user-1");

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.selected).toBe(true);
    expect(workspaces[0]?.workspace.id).toBe(selected.workspace.id);
    expect(workspaces[0]?.workspace.lastSelectedBranch).toBe("dev");
    expect(
      await repository.findWorkspaceConfiguration(
        "user-1",
        selected.workspace.id,
      ),
    ).toMatchObject({ version: 2 });
    await repository.updateWorkspaceConfiguration({
      userId: "user-1",
      workspaceId: selected.workspace.id,
      expectedVersion: 2,
      expectedRepository: { id: selected.repository.id, providerRepoId: "123" },
      patch: { name: "Custom name" },
      now: "2026-05-15T00:00:00.000Z",
    });
    const sameBranch = await repository.selectWorkspace(
      createSelectionInput("user-1", "dev"),
    );
    expect(sameBranch.workspace.name).toBe("Custom name");
    expect(
      await repository.findWorkspaceConfiguration(
        "user-1",
        selected.workspace.id,
      ),
    ).toMatchObject({ version: 3 });
    await repository.selectWorkspace(createSelectionInput("user-1", "next"));
    expect(
      await repository.findWorkspaceConfiguration(
        "user-1",
        selected.workspace.id,
      ),
    ).toMatchObject({ version: 4 });
    const otherInput = createSelectionInput("user-1", "other-branch");
    await repository.selectWorkspace({
      ...otherInput,
      repository: {
        ...otherInput.repository,
        name: "other",
        fullName: "acme/other",
      },
    });
    await repository.updateWorkspaceConfiguration({
      userId: "user-1",
      workspaceId: selected.workspace.id,
      expectedVersion: 4,
      expectedRepository: { id: selected.repository.id, providerRepoId: "123" },
      patch: { selectedBranch: "unselected-edit" },
      now: "2026-05-16T00:00:00.000Z",
    });
    expect(await repository.findWorkspaceSelection("user-1")).toMatchObject({
      repository: { fullName: "acme/other" },
      selection: { selectedBranch: "other-branch" },
    });
  });
});

function createSelectionInput(userId: string, selectedBranch: string) {
  return {
    userId,
    selectedBranch,
    now: "2026-05-14T00:00:00.000Z",
    repository: {
      provider: "github",
      owner: "acme",
      name: "legioncode",
      fullName: "acme/legioncode",
      repoUrl: "https://github.com/acme/legioncode",
      defaultBranch: "main",
      providerRepoId: "123",
      now: "2026-05-14T00:00:00.000Z",
    },
  };
}
