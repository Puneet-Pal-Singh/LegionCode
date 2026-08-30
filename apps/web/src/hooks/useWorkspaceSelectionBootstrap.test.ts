import { describe, expect, it } from "vitest";
import { repositoryFromWorkspaceSelection } from "./useWorkspaceSelectionBootstrap";

describe("repositoryFromWorkspaceSelection", () => {
  it("maps the durable server selection into Web repository context", () => {
    const repository = repositoryFromWorkspaceSelection({
      workspaceId: "workspace-1",
      repoId: "repo-1",
      selectedBranch: "feature/onboarding",
      workspaceName: "legioncode/legioncode",
      updatedAt: "2026-08-12T12:00:00.000Z",
      repository: {
        id: "repo-1",
        provider: "github",
        owner: "legioncode",
        name: "legioncode",
        fullName: "legioncode/legioncode",
        repoUrl: "https://github.com/legioncode/legioncode",
        defaultBranch: "main",
        providerRepoId: "42",
        createdAt: "2026-08-12T12:00:00.000Z",
        updatedAt: "2026-08-12T12:00:00.000Z",
      },
    });

    expect(repository).toMatchObject({
      id: 42,
      full_name: "legioncode/legioncode",
      default_branch: "feature/onboarding",
    });
  });
});
