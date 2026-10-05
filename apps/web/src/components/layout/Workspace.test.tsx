import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { Workspace } from "./Workspace";
import type { UseChatResult } from "../../hooks/useChat";
import { clearInitialPromptSubmissionClaimsForTests } from "./workspace/initialPromptSubmissionGuard";
import { createInitialPromptSubmissionId } from "../../lib/initial-prompt-submission";

const mockRefetchGitStatus = vi.hoisted(() => vi.fn(async () => {}));
const mockUseGitStatusInputs = vi.hoisted(
  () =>
    [] as Array<{
      runId?: string;
      sessionId?: string;
      enabled?: boolean;
    }>,
);
const mockChatState = vi.hoisted(() => ({
  messages: [] as Array<{ role: "user" | "assistant"; content: string }>,
  input: "",
  handleInputChange: vi.fn(),
  handleSubmit: vi.fn(),
  append: vi.fn(),
  reviseTurn: vi.fn(),
  stop: vi.fn(),
  isLoading: false,
  isHydrating: false,
  hasHydrated: true,
  runId: "run-123",
  activeTurnProjection: {
    scope: null,
    serverTurnId: null,
    projection: null,
    hasCanonicalTurn: false,
    hasReplay: false,
    isActive: false,
    isTerminal: false,
    isTransportPending: false,
  },
  isModelConfigReady: true,
  error: null as string | null,
  debugEvents: [],
}));
const mockGitHubTreeState = vi.hoisted(() => ({
  repoTree: [],
  isLoadingTree: false,
  repo: null as {
    owner: { login: string };
    name: string;
    full_name: string;
    html_url: string;
    default_branch: string;
  } | null,
  branch: "main",
  switchBranch: vi.fn(),
  isGitHubLoaded: false,
  isContextMismatch: false,
}));
const mockGitStatusState = vi.hoisted(() => ({
  status: {
    branch: "main",
    files: [],
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: false,
    gitAvailable: true,
  },
}));
const mockWorkspaceStateSetters = vi.hoisted(() => ({
  setActiveTab: vi.fn(),
  setSidebarWidth: vi.fn(),
  setIsResizing: vi.fn(),
  setSelectedFile: vi.fn(),
  setSelectedDiff: vi.fn(),
  openFileTab: vi.fn(),
  openDiffTab: vi.fn(),
  selectContentTab: vi.fn(),
  closeContentTab: vi.fn(),
  setIsViewingContent: vi.fn(),
  setIsLoadingContent: vi.fn(),
}));
const mockChatInterface = vi.hoisted(() =>
  vi.fn((props: unknown) => {
    void props;
    return <div>chat</div>;
  }),
);

function TestWorkspace(
  props: Omit<
    ComponentProps<typeof Workspace>,
    "chat" | "productMode" | "setProductMode" | "registerFileCreatedRefresh"
  >,
) {
  return (
    <Workspace
      {...props}
      chat={mockChatState as unknown as UseChatResult}
      productMode="ask_always"
      setProductMode={() => undefined}
      registerFileCreatedRefresh={() => undefined}
    />
  );
}

vi.mock("../../hooks/useGitStatus", () => ({
  useGitStatus: (runId?: string, sessionId?: string, enabled?: boolean) => {
    mockUseGitStatusInputs.push({ runId, sessionId, enabled });
    return {
      status: enabled === false ? null : mockGitStatusState.status,
      gitAvailable:
        enabled === false ? undefined : mockGitStatusState.status.gitAvailable,
      refetch: mockRefetchGitStatus,
    };
  },
}));

vi.mock("../../hooks/useGitDiff", () => ({
  useGitDiff: () => ({
    fetch: vi.fn(),
    diff: null,
  }),
}));

vi.mock("./workspace/useWorkspaceState", () => ({
  useWorkspaceState: () => ({
    activeTab: "changes",
    setActiveTab: mockWorkspaceStateSetters.setActiveTab,
    sidebarWidth: 320,
    setSidebarWidth: mockWorkspaceStateSetters.setSidebarWidth,
    isResizing: false,
    setIsResizing: mockWorkspaceStateSetters.setIsResizing,
    contentTabs: [],
    activeContentTabId: null,
    selectedFile: null,
    setSelectedFile: mockWorkspaceStateSetters.setSelectedFile,
    selectedDiff: null,
    setSelectedDiff: mockWorkspaceStateSetters.setSelectedDiff,
    openFileTab: mockWorkspaceStateSetters.openFileTab,
    openDiffTab: mockWorkspaceStateSetters.openDiffTab,
    selectContentTab: mockWorkspaceStateSetters.selectContentTab,
    closeContentTab: mockWorkspaceStateSetters.closeContentTab,
    isViewingContent: false,
    setIsViewingContent: mockWorkspaceStateSetters.setIsViewingContent,
    isLoadingContent: false,
    setIsLoadingContent: mockWorkspaceStateSetters.setIsLoadingContent,
  }),
}));

vi.mock("./workspace/useGitHubTree", () => ({
  useGitHubTree: () => mockGitHubTreeState,
}));

vi.mock("./workspace/useFileLoader", () => ({
  useFileLoader: () => ({
    handleFileClick: vi.fn(),
    handleGitHubFileSelect: vi.fn(),
  }),
}));

vi.mock("../chat/ChatInterface", () => ({
  ChatInterface: (props: unknown) => mockChatInterface(props),
}));

vi.mock("../ui/Resizer", () => ({
  Resizer: () => null,
}));

vi.mock("./workspace/SidebarHeader", () => ({
  SidebarHeader: () => <div>header</div>,
}));

vi.mock("./workspace/SidebarContent", () => ({
  SidebarContent: () => <div>content</div>,
}));

vi.mock("../git/GitReviewContext", () => ({
  GitReviewProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../git/useGitReview", () => ({
  useGitReview: () => ({
    status: {
      branch: "main",
      files: [],
      ahead: 0,
      behind: 0,
      hasStaged: false,
      hasUnstaged: false,
      gitAvailable: true,
    },
    gitAvailable: true,
    statusLoading: false,
    statusError: null,
    diff: null,
    diffError: null,
    stageError: null,
    commitError: null,
    commitErrorCode: null,
    commitErrorMetadata: null,
    diffLoading: false,
    committing: false,
    isReviewOpen: false,
    selectedFile: null,
    reviewFiles: [],
    stagedFiles: new Set<string>(),
    commitMessage: "",
    reviewComments: [],
    selectedReviewComments: [],
    selectedReviewCommentCount: 0,
    selectedReviewCommentsForFile: [],
    currentDiffFingerprint: null,
    reviewScope: "git-changes",
    setReviewScope: vi.fn(),
    reviewSource: { kind: "live_git", reason: "empty" },
    reviewSourceLoading: false,
    reviewSourceError: null,
    openReview: vi.fn(),
    openPromptArtifactReview: vi.fn(),
    openLiveGitReview: vi.fn(),
    closeReview: vi.fn(),
    selectFile: vi.fn(),
    addReviewComment: vi.fn(),
    deleteReviewComment: vi.fn(),
    toggleReviewCommentSelected: vi.fn(),
    markReviewCommentsDispatching: vi.fn(),
    markReviewCommentsDispatched: vi.fn(),
    markReviewCommentsDispatchFailed: vi.fn(),
    toggleFileStaged: vi.fn(),
    stageAll: vi.fn(),
    unstageAll: vi.fn(),
    createBranch: vi.fn(),
    pushBranch: vi.fn(),
    submitCommit: vi.fn(),
    setCommitMessage: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../git/GitReviewDialog", () => ({
  GitReviewDialog: () => null,
}));

vi.mock("../git/GitCommitDialog", () => ({
  GitCommitDialog: () => null,
}));

describe("Workspace", () => {
  beforeEach(() => {
    clearInitialPromptSubmissionClaimsForTests();
    mockChatInterface.mockClear();
    mockRefetchGitStatus.mockClear();
    mockUseGitStatusInputs.length = 0;
    mockChatState.stop.mockClear();
    mockChatState.append.mockClear();
    mockChatState.append.mockResolvedValue(acceptedSubmission());
    Object.values(mockWorkspaceStateSetters).forEach((setter) =>
      setter.mockClear(),
    );
    mockChatState.isLoading = false;
    mockChatState.messages = [];
    mockChatState.runId = "run-123";
    mockChatState.isModelConfigReady = true;
    mockChatState.error = null;
    mockGitStatusState.status = {
      branch: "main",
      files: [],
      ahead: 0,
      behind: 0,
      hasStaged: false,
      hasUnstaged: false,
      gitAvailable: true,
    };
    mockGitHubTreeState.repo = null;
    mockGitHubTreeState.branch = "main";
    mockGitHubTreeState.switchBranch.mockClear();
    mockGitHubTreeState.isGitHubLoaded = false;
    mockGitHubTreeState.isContextMismatch = false;
  });

  it("routes top-summary change requests into the review changes tab", () => {
    const setIsRightSidebarOpen = vi.fn();
    render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        setIsRightSidebarOpen={setIsRightSidebarOpen}
        summaryActionRequest={{ id: 1, action: "changes" }}
      />,
    );

    expect(setIsRightSidebarOpen).toHaveBeenCalledWith(true);
    expect(mockWorkspaceStateSetters.setIsViewingContent).toHaveBeenCalledWith(
      false,
    );
    expect(mockWorkspaceStateSetters.setActiveTab).toHaveBeenCalledWith(
      "changes",
    );
  });

  it("submits an initial setup prompt once across workspace remounts", async () => {
    clearInitialPromptSubmissionClaimsForTests();
    mockChatState.append.mockResolvedValue(acceptedSubmission());
    const onInitialPromptHandled = vi.fn();
    const initialPromptSubmission = {
      id: createInitialPromptSubmissionId("setup-prompt-1"),
      prompt:
        "Hey, read my readme and tell what do you think of this project??",
    };
    const firstRender = render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        initialPromptSubmission={initialPromptSubmission}
        onInitialPromptHandled={onInitialPromptHandled}
      />,
    );

    await waitFor(() => {
      expect(mockChatState.append).toHaveBeenCalledTimes(1);
    });
    firstRender.unmount();

    render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        initialPromptSubmission={initialPromptSubmission}
        onInitialPromptHandled={onInitialPromptHandled}
      />,
    );

    await waitFor(() => {
      expect(onInitialPromptHandled).toHaveBeenCalledWith("setup-prompt-1");
    });
    expect(mockChatState.append).toHaveBeenCalledTimes(1);
    expect(mockChatState.append).toHaveBeenCalledWith({
      id: "client_msg_setup-prompt-1",
      role: "user",
      content:
        "Hey, read my readme and tell what do you think of this project??",
    });
  });

  it("waits for model configuration before submitting an initial setup prompt", async () => {
    clearInitialPromptSubmissionClaimsForTests();
    mockChatState.append.mockClear();
    mockChatState.isModelConfigReady = false;
    const initialPromptSubmission = {
      id: createInitialPromptSubmissionId("setup-prompt-2"),
      prompt: "Read README",
    };
    const { rerender } = render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        initialPromptSubmission={initialPromptSubmission}
      />,
    );

    expect(mockChatState.append).not.toHaveBeenCalled();

    mockChatState.isModelConfigReady = true;
    rerender(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        initialPromptSubmission={initialPromptSubmission}
      />,
    );

    await waitFor(() => {
      expect(mockChatState.append).toHaveBeenCalledTimes(1);
    });
  });

  it("waits for the session save before admitting the queued setup prompt", async () => {
    clearInitialPromptSubmissionClaimsForTests();
    mockChatState.append.mockClear();
    mockChatState.append.mockResolvedValue(acceptedSubmission());
    const onInitialPromptHandled = vi.fn();
    const initialPromptSubmission = {
      id: createInitialPromptSubmissionId("setup-delayed-save"),
      prompt: "Read README",
    };
    const props = {
      sessionId: "session-delayed",
      runId: "run-123",
      repository: "owner/repo",
      initialPromptSubmission,
      onInitialPromptHandled,
    };
    const { rerender } = render(
      <TestWorkspace {...props} sessionPersistenceStatus="saving" />,
    );

    expect(mockChatState.append).not.toHaveBeenCalled();
    expect(onInitialPromptHandled).not.toHaveBeenCalled();
    rerender(<TestWorkspace {...props} sessionPersistenceStatus="saved" />);

    await waitFor(() => expect(mockChatState.append).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onInitialPromptHandled).toHaveBeenCalledWith("setup-delayed-save"),
    );
  });

  it("keeps the setup prompt queued while save fails and resumes after the existing retry succeeds", async () => {
    clearInitialPromptSubmissionClaimsForTests();
    mockChatState.append.mockClear();
    mockChatState.append.mockResolvedValue(acceptedSubmission());
    const onInitialPromptHandled = vi.fn();
    const initialPromptSubmission = {
      id: createInitialPromptSubmissionId("setup-save-retry"),
      prompt: "Read README",
    };
    const props = {
      sessionId: "session-retry",
      runId: "run-123",
      repository: "owner/repo",
      initialPromptSubmission,
      onInitialPromptHandled,
    };
    const { rerender } = render(
      <TestWorkspace {...props} sessionPersistenceStatus="failed" />,
    );

    expect(mockChatState.append).not.toHaveBeenCalled();
    rerender(<TestWorkspace {...props} sessionPersistenceStatus="saving" />);
    expect(mockChatState.append).not.toHaveBeenCalled();
    rerender(<TestWorkspace {...props} sessionPersistenceStatus="saved" />);

    await waitFor(() => expect(mockChatState.append).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onInitialPromptHandled).toHaveBeenCalledWith("setup-save-retry"),
    );
  });

  it("waits for explicit retry after rejection despite parent callback churn and reuses the client identity", async () => {
    clearInitialPromptSubmissionClaimsForTests();
    mockChatState.append.mockReset();
    mockChatState.append.mockRejectedValueOnce(new Error("response lost"));
    mockChatState.append.mockResolvedValueOnce(acceptedSubmission());
    const onInitialPromptHandled = vi.fn();
    const initialPromptSubmission = {
      id: createInitialPromptSubmissionId("setup-admission-retry"),
      prompt: "Read README",
    };
    function ParentConsumer() {
      const [runStatus, setRunStatus] = useState("running");
      const [workspaceVersion, setWorkspaceVersion] = useState(0);
      return (
        <div data-run-status={runStatus}>
          <button
            type="button"
            onClick={() => setWorkspaceVersion((version) => version + 1)}
          >
            Refresh workspace
          </button>
          <TestWorkspace
            key={workspaceVersion}
            sessionId="session-admission-retry"
            runId="run-123"
            repository="owner/repo"
            initialPromptSubmission={initialPromptSubmission}
            onInitialPromptHandled={onInitialPromptHandled}
            sessionPersistenceStatus="saved"
            // Deliberately inline: the App consumer recreates this callback as
            // parent state changes after an admission failure.
            onSessionStatusChange={(status) => setRunStatus(status)}
          />
        </div>
      );
    }
    const { getByRole } = render(<ParentConsumer />);

    await waitFor(() => expect(mockChatState.append).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(onInitialPromptHandled).not.toHaveBeenCalled();
    const firstMessage = mockChatState.append.mock.calls[0]![0];
    expect(firstMessage.id).toBe("client_msg_setup-admission-retry");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockChatState.append).toHaveBeenCalledTimes(1);

    fireEvent.click(getByRole("button", { name: "Refresh workspace" }));
    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(mockChatState.append).toHaveBeenCalledTimes(1);

    fireEvent.click(getByRole("button", { name: "Retry setup prompt" }));

    await waitFor(() => expect(mockChatState.append).toHaveBeenCalledTimes(2));
    expect(mockChatState.append.mock.calls[1]![0].id).toBe(firstMessage.id);
    await waitFor(() =>
      expect(onInitialPromptHandled).toHaveBeenCalledWith(
        "setup-admission-retry",
      ),
    );
  });

  it.each([
    [
      "before dispatch",
      { status: "cancelled", admission: "not-dispatched" },
      true,
      false,
    ],
    [
      "after admission",
      { status: "cancelled", admission: "accepted" },
      true,
      false,
    ],
    [
      "with uncertain admission",
      { status: "cancelled", admission: "unconfirmed" },
      false,
      true,
    ],
  ] as const)(
    "handles a stopped setup submission %s according to its admission fact",
    async (_label, outcome, handled, showsRetry) => {
      clearInitialPromptSubmissionClaimsForTests();
      mockChatState.append.mockReset();
      mockChatState.append.mockResolvedValueOnce(outcome);
      const onInitialPromptHandled = vi.fn();
      const initialPromptSubmission = {
        id: createInitialPromptSubmissionId(
          `setup-stop-${_label.replaceAll(" ", "-")}`,
        ),
        prompt: "Stop this setup prompt",
      };
      const { queryByRole } = render(
        <TestWorkspace
          sessionId={`session-stop-${_label}`}
          runId="run-123"
          repository="owner/repo"
          initialPromptSubmission={initialPromptSubmission}
          onInitialPromptHandled={onInitialPromptHandled}
        />,
      );

      await waitFor(() =>
        expect(mockChatState.append).toHaveBeenCalledTimes(1),
      );
      if (handled) {
        await waitFor(() =>
          expect(onInitialPromptHandled).toHaveBeenCalledWith(
            initialPromptSubmission.id,
          ),
        );
      } else {
        await waitFor(() =>
          expect(
            queryByRole("button", { name: "Retry setup prompt" }),
          ).toBeTruthy(),
        );
        expect(onInitialPromptHandled).not.toHaveBeenCalled();
      }
      expect(
        Boolean(queryByRole("button", { name: "Retry setup prompt" })),
      ).toBe(showsRetry);
    },
  );

  it("blocks composer and revision admission while the session is unsaved", async () => {
    mockChatState.handleSubmit.mockClear();
    mockChatState.reviseTurn.mockClear();
    const { rerender } = render(
      <TestWorkspace
        sessionId="session-unsaved"
        runId="run-123"
        repository="owner/repo"
        sessionPersistenceStatus="saving"
      />,
    );
    const chatProps = mockChatInterface.mock.calls.at(-1)?.[0] as {
      chatProps: {
        handleSubmit: () => Promise<boolean>;
        reviseTurn: (turnId: string, prompt: string) => Promise<boolean>;
        append: (message: {
          role: "user";
          content: string;
        }) => Promise<unknown>;
      };
    };
    await expect(chatProps.chatProps.handleSubmit()).resolves.toBe(false);
    await expect(
      chatProps.chatProps.reviseTurn("turn-1", "revise"),
    ).resolves.toBe(false);
    await expect(
      chatProps.chatProps.append({ role: "user", content: "send" }),
    ).rejects.toThrow(/still being saved/);
    expect(mockChatState.handleSubmit).not.toHaveBeenCalled();
    expect(mockChatState.reviseTurn).not.toHaveBeenCalled();

    rerender(
      <TestWorkspace
        sessionId="session-unsaved"
        runId="run-123"
        repository="owner/repo"
        sessionPersistenceStatus="saved"
      />,
    );
    const savedChatProps = mockChatInterface.mock.calls.at(
      -1,
    )?.[0] as typeof chatProps;
    await savedChatProps.chatProps.handleSubmit();
    expect(mockChatState.handleSubmit).toHaveBeenCalledTimes(1);
  });

  it("preserves setup-composer images in the first workspace message", async () => {
    clearInitialPromptSubmissionClaimsForTests();
    mockChatState.append.mockResolvedValue(acceptedSubmission());
    const initialPromptSubmission = {
      id: createInitialPromptSubmissionId("setup-image-1"),
      prompt: "Inspect this screenshot",
      attachments: {
        imageAttachments: [
          {
            id: "image-1",
            name: "screen.png",
            mediaType: "image/png" as const,
            dataUrl: "data:image/png;base64,aGVsbG8=",
            previewUrl: "blob:image-preview",
            byteSize: 5,
            source: "upload" as const,
          },
        ],
      },
    };

    render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        initialPromptSubmission={initialPromptSubmission}
      />,
    );

    await waitFor(() => {
      expect(mockChatState.append).toHaveBeenCalledWith({
        id: "client_msg_setup-image-1",
        role: "user",
        content: [
          { type: "text", text: "Inspect this screenshot" },
          {
            type: "image",
            image: "data:image/png;base64,aGVsbG8=",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
        imageMetadata: [
          {
            id: "image-1",
            name: "screen.png",
            mediaType: "image/png",
            byteSize: 5,
            source: "upload",
          },
        ],
      });
    });
  });

  it("does not probe live Git during the automatic chat flow", async () => {
    mockGitHubTreeState.repo = {
      owner: { login: "Puneet-Pal-Singh" },
      name: "career-crew",
      full_name: "Puneet-Pal-Singh/career-crew",
      html_url: "https://github.com/Puneet-Pal-Singh/career-crew",
      default_branch: "main",
    };
    mockGitHubTreeState.isGitHubLoaded = true;
    mockChatState.isLoading = true;

    render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="Puneet-Pal-Singh/career-crew"
      />,
    );

    expect(mockUseGitStatusInputs).toContainEqual({
      runId: "run-123",
      sessionId: "session-123",
      enabled: false,
    });
  });

  it("passes repo tree state to the chat interface", () => {
    mockGitHubTreeState.repo = {
      owner: { login: "Puneet-Pal-Singh" },
      name: "career-crew",
      full_name: "Puneet-Pal-Singh/career-crew",
      html_url: "https://github.com/Puneet-Pal-Singh/career-crew",
      default_branch: "main",
    };
    mockGitHubTreeState.isGitHubLoaded = true;

    render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career crew renamed"
      />,
    );

    expect(mockChatInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        repoTree: [],
        isLoadingRepoTree: false,
      }),
    );
  });

  it("passes SDK loading state directly to chat interface", () => {
    mockChatState.isLoading = false;

    render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
      />,
    );

    expect(mockChatInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        chatProps: expect.objectContaining({
          isLoading: false,
        }),
      }),
    );
  });

  it("passes SDK loading state even when summary is terminal", () => {
    mockChatState.isLoading = true;

    render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        isSessionRunning
      />,
    );

    expect(mockChatInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        chatProps: expect.objectContaining({
          isLoading: true,
        }),
      }),
    );
  });

  it("passes SDK loading state when no summary exists", () => {
    mockChatState.isLoading = false;

    render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        isSessionRunning
      />,
    );

    expect(mockChatInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        chatProps: expect.objectContaining({
          isLoading: false,
        }),
      }),
    );
  });

  it("opens the right sidebar when review focus is requested", () => {
    const setIsRightSidebarOpen = vi.fn();
    const { rerender } = render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        setIsRightSidebarOpen={setIsRightSidebarOpen}
        reviewSidebarFocusRequest={0}
      />,
    );

    expect(setIsRightSidebarOpen).not.toHaveBeenCalled();

    rerender(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        setIsRightSidebarOpen={setIsRightSidebarOpen}
        reviewSidebarFocusRequest={1}
      />,
    );

    expect(setIsRightSidebarOpen).toHaveBeenCalledWith(true);
    expect(mockWorkspaceStateSetters.setActiveTab).toHaveBeenCalledWith(
      "review",
    );
  });

  it("opens the right sidebar review tab from a completed edit", () => {
    const onGitReviewOpenChange = vi.fn();
    const setIsRightSidebarOpen = vi.fn();
    render(
      <TestWorkspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onGitReviewOpenChange={onGitReviewOpenChange}
        setIsRightSidebarOpen={setIsRightSidebarOpen}
      />,
    );

    const chatProps = mockChatInterface.mock.calls.at(-1)?.[0] as {
      onReviewOpen?: () => void;
    };
    chatProps.onReviewOpen?.();

    expect(onGitReviewOpenChange).not.toHaveBeenCalled();
    expect(setIsRightSidebarOpen).toHaveBeenCalledWith(true);
    expect(mockWorkspaceStateSetters.setIsViewingContent).toHaveBeenCalledWith(
      false,
    );
    expect(mockWorkspaceStateSetters.setActiveTab).toHaveBeenCalledWith(
      "review",
    );
  });
});

function acceptedSubmission() {
  return {
    status: "accepted" as const,
    scope: {
      workspaceId: "wsp_workspace_test01",
      threadId: "thr_workspace_test01",
      turnId: "trn_workspace_test01",
      runAttemptId: "attempt_workspace_test01",
      sessionId: "session-workspace-test",
      runId: "run-workspace-test",
    },
  };
}
