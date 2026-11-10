import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostedWorkspaceConfigurationEditor, PickerModal } from "@legioncode/client-ui";
import { createAppServerClient, type AppServerTransport, type HostedWorkspaceConfiguration } from "@legioncode/sdk";
import { ThreadIdSchema, TurnDiffPayloadSchema, WorkspaceIdSchema } from "@repo/platform-protocol";
import { DesktopSavedCommitDialog } from "../../../../desktop/src/renderer/src/DesktopSavedCommitDialog";
import { AuthorizedRepositoryPicker } from "./AuthorizedRepositoryPicker";
import { RepositoryPickerModal } from "./RepositoryPickerModal";
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
    const onPickerClose = vi.fn();
    const applicationRoot = document.createElement("div");
    applicationRoot.id = "root";
    // Reflect inert as a browser does, so helper visibility checks exercise
    // the actual portal parent's cleanup order in this jsdom fixture.
    Object.defineProperty(applicationRoot, "inert", {
      get: () => applicationRoot.hasAttribute("inert"),
      set: (value: boolean) => applicationRoot.toggleAttribute("inert", value),
    });
    const opener = document.createElement("button");
    applicationRoot.append(opener);
    document.body.append(applicationRoot);
    opener.focus();
    const picker = render(<RepositoryPickerModal onRepoSelect={onRepoSelect} onClose={onPickerClose} />);
    expect(applicationRoot).toHaveAttribute("inert");

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
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onPickerClose).not.toHaveBeenCalled();
    screen.getByRole("dialog").focus();
    expect(opener).not.toHaveFocus();
    picker.unmount();
    expect(applicationRoot).not.toHaveAttribute("inert");
    expect(opener).toHaveFocus();
    applicationRoot.remove();

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
    const onClose = vi.fn();
    const editorOpener = document.createElement("button");
    document.body.append(editorOpener);
    editorOpener.focus();
    const editorView = (workspaceId: string, scopeKey: string) => (
      <PickerModal>
        <HostedWorkspaceConfigurationEditor client={client} workspaceId={workspaceId}
          scopeKey={scopeKey} onClose={onClose} onSaved={onSaved} />
      </PickerModal>
    );
    const editor = render(editorView("workspace-a", "authenticated-session-a"));
    const dialog = screen.getByRole("dialog", { name: "Project settings" });
    dialog.focus();
    const initialShiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(initialShiftTab);
    expect(initialShiftTab.defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: "Close project settings" })).toHaveFocus();
    const preventedEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    preventedEscape.preventDefault();
    window.dispatchEvent(preventedEscape);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(await screen.findByDisplayValue("Saved project")).toBeVisible();
    const startingBranch = await screen.findByLabelText("Starting branch");
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Configured project" } });
    fireEvent.change(startingBranch, { target: { value: "feature/onboarding" } });
    screen.getByRole("button", { name: "Save changes" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(sent.find((request) => request.method === "workspace/configuration/update")?.params).toEqual({
      workspaceId: "workspace-a", expectedVersion: 1,
      patch: { name: "Configured project", selectedBranch: "feature/onboarding" },
    });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // A browser may leave focus on a control as it becomes disabled.
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close project settings" })).toHaveFocus();
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close project settings" })).toHaveFocus();
    document.body.removeAttribute("tabindex");

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
    editor.rerender(editorView("workspace-b", "authenticated-session-b"));
    expect(await screen.findByDisplayValue("Other project")).toBeVisible();
    await act(async () => { finishSave?.(); });
    expect(screen.getByLabelText("Project name")).toHaveValue("Other project");
    expect(onSaved).toHaveBeenCalledTimes(notifications);

    holdNextRead = true;
    editor.rerender(editorView("workspace-a", "authenticated-session-c"));
    expect(screen.queryByDisplayValue("Other project")).not.toBeInTheDocument();
    await waitFor(() => expect(finishRead).toBeDefined());
    editor.rerender(editorView("workspace-b", "authenticated-session-d"));
    expect(await screen.findByDisplayValue("Other project")).toBeVisible();
    await act(async () => { finishRead?.(); });
    expect(screen.getByLabelText("Project name")).toHaveValue("Other project");

    holdNextRead = true;
    finishRead = undefined;
    editor.rerender(editorView("workspace-b", "authenticated-session-e"));
    await waitFor(() => expect(finishRead).toBeDefined());
    const newerDialog = document.createElement("div");
    newerDialog.setAttribute("role", "dialog");
    const newerButton = document.createElement("button");
    newerDialog.append(newerButton);
    document.body.append(newerDialog);
    newerButton.focus();
    await act(async () => {
      finishRead?.();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(screen.getByLabelText("Project name")).toHaveValue("Other project");
    expect(newerButton).toHaveFocus();
    fireEvent.keyDown(newerButton, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    editor.unmount();
    expect(newerButton).toHaveFocus();
    newerDialog.remove();
    editorOpener.remove();

    const hiddenOpener = document.createElement("button");
    document.body.append(hiddenOpener);
    hiddenOpener.focus();
    const hidden = render(editorView("workspace-b", "authenticated-session-f"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close project settings" })).toHaveFocus());
    hiddenOpener.hidden = true;
    hidden.unmount();
    expect(hiddenOpener).not.toHaveFocus();
    hiddenOpener.remove();

    // The other production overlay consumer must retain its own focus lifetime.
    const snapshot = {
      turnId: "trn_savedfocus001", snapshotKey: "saved-focus-start", treeId: "a".repeat(40),
      headSha: "b".repeat(40), phase: "start", capturedAt: "2026-06-08T15:00:00.000Z",
    };
    const savedDiff = TurnDiffPayloadSchema.parse({
      turnId: snapshot.turnId, startSnapshot: snapshot,
      terminalSnapshot: { ...snapshot, snapshotKey: "saved-focus-terminal", phase: "terminal" },
      files: [], patch: "",
    });
    const workspaceId = WorkspaceIdSchema.parse("wrk_savedfocus001");
    const threadId = ThreadIdSchema.parse("thr_savedfocus001");
    const onCommitClose = vi.fn();
    const commitClient = { commitTurnArtifact: vi.fn(async () => { throw new Error("No commit expected"); }) };
    const savedView = () => (
      <DesktopSavedCommitDialog isOpen onClose={onCommitClose} client={commitClient}
        selection={{ workspaceId, threadId, turnId: savedDiff.turnId, terminalState: "completed" }}
        diff={savedDiff} scope={{ workspaceId, threadId, grantedAt: snapshot.capturedAt, readiness: "ready" }}
        availability={{ available: true }} />
    );
    document.body.append(applicationRoot);
    opener.focus();
    const saved = render(savedView());
    const savedDialog = screen.getByRole("dialog", { name: "Commit saved changes" });
    await waitFor(() => expect(savedDialog.contains(document.activeElement)).toBe(true));
    expect(applicationRoot).toHaveAttribute("inert");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCommitClose).toHaveBeenCalledTimes(1);
    saved.unmount();
    expect(applicationRoot).not.toHaveAttribute("inert");
    expect(opener).toHaveFocus();

    const newerSaved = render(savedView());
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Commit saved changes" }).contains(document.activeElement)).toBe(true));
    document.body.append(newerDialog);
    newerButton.focus();
    newerSaved.unmount();
    expect(newerButton).toHaveFocus();
    newerDialog.remove();

    opener.focus();
    const hiddenSaved = render(savedView());
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Commit saved changes" }).contains(document.activeElement)).toBe(true));
    opener.hidden = true;
    hiddenSaved.unmount();
    expect(opener).not.toHaveFocus();
    expect(commitClient.commitTurnArtifact).not.toHaveBeenCalled();
    applicationRoot.remove();
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
