import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostedWorkspaceConfigurationEditor } from "@legioncode/client-ui";
import { createAppServerClient, type AppServerTransport, type HostedWorkspaceConfiguration } from "@legioncode/sdk";
import { AuthorizedRepositoryPicker } from "./AuthorizedRepositoryPicker";
import * as GitHubService from "../../services/GitHubService";

vi.mock("../../services/GitHubService", () => ({
  listRepositories: vi.fn(),
  listBranches: vi.fn(),
  initiateGitHubReauthorization: vi.fn(),
}));

vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

const repository = {
  id: 42,
  name: "legioncode",
  full_name: "legioncode/legioncode",
  owner: { login: "legioncode", avatar_url: "" },
  description: "Agent workspace",
  private: true,
  html_url: "https://github.com/legioncode/legioncode",
  clone_url: "https://github.com/legioncode/legioncode.git",
  default_branch: "main",
  stargazers_count: 0,
  language: "TypeScript",
  updated_at: new Date().toISOString(),
};

describe("AuthorizedRepositoryPicker", () => {
  beforeEach(() => {
    vi.mocked(GitHubService.listRepositories).mockResolvedValue([repository]);
    vi.mocked(GitHubService.listBranches).mockResolvedValue([
      {
        name: "main",
        protected: true,
        commit: { sha: "abc1234", url: "https://api.github.test/commit" },
      },
      {
        name: "feature/onboarding",
        protected: false,
        commit: { sha: "def5678", url: "https://api.github.test/commit-2" },
      },
    ]);
  });

  it("selects an authorized repository and branch before opening a workspace", async () => {
    const onRepoSelect = vi.fn(async () => undefined);
    const picker = render(<AuthorizedRepositoryPicker onRepoSelect={onRepoSelect} />);

    const repoButton = await screen.findByRole("button", {
      name: /legioncode\/legioncode/i,
    });
    fireEvent.click(repoButton);

    expect(onRepoSelect).not.toHaveBeenCalled();
    expect(screen.queryByText("01 AUTHORIZED")).not.toBeInTheDocument();
    const branch = await screen.findByLabelText("Starting branch");
    fireEvent.change(branch, { target: { value: "feature/onboarding" } });
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    await waitFor(() =>
      expect(onRepoSelect).toHaveBeenCalledWith(
        repository,
        "feature/onboarding",
      ),
    );
    picker.unmount();

    // The extracted presentation also consumes actual SDK configuration methods.
    // Keep the server's acknowledged revision separate from the unsaved draft.
    type Request = Parameters<AppServerTransport["request"]>[0];
    const configuration = (workspaceId: string, name: string): HostedWorkspaceConfiguration => ({
      workspaceId, name, selectedBranch: "main", version: 1,
      repository: {
        id: "saved-repository", provider: "github", owner: "legioncode", name: "legioncode",
        fullName: repository.full_name, repoUrl: repository.html_url, defaultBranch: "main",
        providerRepoId: "42", createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z",
      },
    });
    const configurations = new Map([
      ["workspace-a", configuration("workspace-a", "Saved project")],
      ["workspace-b", configuration("workspace-b", "Other project")],
    ]);
    const sent: Request[] = [];
    const success = (request: Request, result: unknown) => ({
      protocolVersion: "1.0.0", method: request.method, ok: true, result,
    });
    let conflictNextSave = false;
    let holdNextSave = false;
    let holdNextRead = false;
    let finishSave: (() => void) | undefined;
    let finishRead: (() => void) | undefined;
    const client = createAppServerClient({
      clientId: "project-settings-fixture", clientVersion: "0.1.0",
      transport: {
        async request(request) {
          sent.push(request);
          if (request.method === "workspace/configuration/read") {
            const result = configurations.get(request.params.workspaceId)!;
            if (holdNextRead) {
              holdNextRead = false;
              return new Promise((resolve) => { finishRead = () => resolve(success(request, result)); });
            }
            return success(request, result);
          }
          if (request.method === "repository/branches")
            return success(request, { branches: [
              { name: "main", protected: true, commit: { sha: "abc1234", url: "https://api.github.test/commit" } },
              { name: "feature/onboarding", protected: false, commit: { sha: "def5678", url: "https://api.github.test/commit-2" } },
            ] });
          if (request.method === "workspace/configuration/update") {
            const current = configurations.get(request.params.workspaceId)!;
            if (conflictNextSave) {
              conflictNextSave = false;
              configurations.set(current.workspaceId, { ...current, name: "Changed elsewhere", version: current.version + 1 });
              return { protocolVersion: "1.0.0", method: request.method, ok: false,
                error: { code: "conflict", statusCode: 409, operationCode: "WORKSPACE_CONFIGURATION_CONFLICT", retryable: false, message: "Settings changed" } };
            }
            expect(request.params.expectedVersion).toBe(current.version);
            const result = { ...current, ...request.params.patch, version: current.version + 1 };
            configurations.set(result.workspaceId, result);
            if (holdNextSave) {
              holdNextSave = false;
              return new Promise((resolve) => { finishSave = () => resolve(success(request, result)); });
            }
            return success(request, result);
          }
          throw new Error("Unexpected settings operation");
        },
      },
    });
    const onSaved = vi.fn(async () => undefined);
    const editor = render(<HostedWorkspaceConfigurationEditor client={client} workspaceId="workspace-a"
      scopeKey="authenticated-session-a" onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByRole("dialog", { name: "Project settings" })).toHaveFocus();
    expect(await screen.findByDisplayValue("Saved project")).toBeVisible();
    const startingBranch = await screen.findByLabelText("Starting branch");
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Configured project" } });
    fireEvent.change(startingBranch, { target: { value: "feature/onboarding" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(sent.find((request) => request.method === "workspace/configuration/update")?.params).toEqual({
      workspaceId: "workspace-a", expectedVersion: 1,
      patch: { name: "Configured project", selectedBranch: "feature/onboarding" },
    });

    conflictNextSave = true;
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "My unsaved edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect(screen.getByLabelText("Project name")).toHaveValue("My unsaved edit");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    const saveCount = sent.filter((request) => request.method === "workspace/configuration/update").length;
    fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
    expect(await screen.findByDisplayValue("Changed elsewhere")).toBeVisible();
    expect(sent.filter((request) => request.method === "workspace/configuration/update")).toHaveLength(saveCount);
    onSaved.mockRejectedValueOnce(new Error("Navigation refresh unavailable"));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "After reload" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Project settings saved. Reopen the project list to refresh it.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("After reload");

    holdNextSave = true;
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Pending old scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(finishSave).toBeDefined());
    const notifications = onSaved.mock.calls.length;
    editor.rerender(<HostedWorkspaceConfigurationEditor client={client} workspaceId="workspace-b"
      scopeKey="authenticated-session-b" onClose={vi.fn()} onSaved={onSaved} />);
    expect(await screen.findByDisplayValue("Other project")).toBeVisible();
    await act(async () => { finishSave?.(); });
    expect(screen.getByLabelText("Project name")).toHaveValue("Other project");
    expect(onSaved).toHaveBeenCalledTimes(notifications);

    holdNextRead = true;
    editor.rerender(<HostedWorkspaceConfigurationEditor client={client} workspaceId="workspace-a"
      scopeKey="authenticated-session-c" onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.queryByDisplayValue("Other project")).not.toBeInTheDocument();
    await waitFor(() => expect(finishRead).toBeDefined());
    editor.rerender(<HostedWorkspaceConfigurationEditor client={client} workspaceId="workspace-b"
      scopeKey="authenticated-session-d" onClose={vi.fn()} onSaved={onSaved} />);
    expect(await screen.findByDisplayValue("Other project")).toBeVisible();
    await act(async () => { finishRead?.(); });
    expect(screen.getByLabelText("Project name")).toHaveValue("Other project");
    editor.unmount();
  });

  it("offers one repair action when no repositories are granted", async () => {
    vi.mocked(GitHubService.listRepositories).mockResolvedValue([]);
    render(<AuthorizedRepositoryPicker onRepoSelect={vi.fn()} />);

    expect(
      await screen.findByRole("heading", {
        name: "No repositories are available",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Manage GitHub access/i }),
    );
    expect(GitHubService.initiateGitHubReauthorization).toHaveBeenCalledTimes(
      1,
    );
  });
});
