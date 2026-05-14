import { describe, expect, it } from "vitest";
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
