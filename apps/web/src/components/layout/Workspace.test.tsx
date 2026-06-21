import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { Workspace } from "./Workspace";

const mockRefetchGitStatus = vi.hoisted(() => vi.fn(async () => {}));
const mockUseGitStatusInputs = vi.hoisted(
  () =>
    [] as Array<{
      runId?: string;
      sessionId?: string;
      enabled?: boolean;
    }>,
);
const mockBootstrapGitWorkspace = vi.hoisted(() => vi.fn());
const mockChatState = vi.hoisted(() => ({
  messages: [] as Array<{ role: "user" | "assistant"; content: string }>,
  input: "",
  handleInputChange: vi.fn(),
  handleSubmit: vi.fn(),
  append: vi.fn(),
  stop: vi.fn(),
  isLoading: false,
  isHydrating: false,
  hasHydrated: true,
  runId: "run-123",
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
const mockRunSummaryState = vi.hoisted(() => ({
  summary: null as {
    runId: string;
    status: string | null;
    pendingApproval?: unknown;
  } | null,
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

vi.mock("../../hooks/useChat", () => ({
  useChat: () => mockChatState,
}));

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

vi.mock("../../hooks/useRunSummary", () => ({
  useRunSummary: () => mockRunSummaryState,
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

vi.mock("../../lib/git-workspace-bootstrap", () => ({
  bootstrapGitWorkspace: mockBootstrapGitWorkspace,
}));

describe("Workspace", () => {
  beforeEach(() => {
    mockChatInterface.mockClear();
    mockRefetchGitStatus.mockClear();
    mockUseGitStatusInputs.length = 0;
    mockChatState.stop.mockClear();
    Object.values(mockWorkspaceStateSetters).forEach((setter) =>
      setter.mockClear(),
    );
    mockBootstrapGitWorkspace.mockReset();
    mockBootstrapGitWorkspace.mockResolvedValue({ status: "ready" });
    mockChatState.isLoading = false;
    mockChatState.messages = [];
    mockChatState.runId = "run-123";
    mockChatState.error = null;
    mockRunSummaryState.summary = null;
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
      <Workspace
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

  it("refreshes git status when local chat loading settles", async () => {
    const onSessionStatusChange = vi.fn();
    const { rerender } = render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    expect(mockRefetchGitStatus).not.toHaveBeenCalled();

    mockChatState.isLoading = true;
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    expect(mockRefetchGitStatus).not.toHaveBeenCalled();
    expect(onSessionStatusChange).toHaveBeenCalledWith("running");

    mockChatState.isLoading = false;
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    await waitFor(() => {
      expect(mockRefetchGitStatus).toHaveBeenCalledWith(true);
    });
    expect(onSessionStatusChange).toHaveBeenCalledWith("completed");

    mockRefetchGitStatus.mockClear();
    onSessionStatusChange.mockClear();

    mockRunSummaryState.summary = { runId: "run-123", status: "COMPLETED" };
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    await waitFor(() => {
      expect(mockRefetchGitStatus).toHaveBeenCalledWith(true);
    });
    expect(onSessionStatusChange).toHaveBeenCalledWith("completed");
  });

  it("re-applies canonical terminal status side-effects when the active run changes", async () => {
    const onSessionStatusChange = vi.fn();
    const { rerender } = render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    mockRunSummaryState.summary = { runId: "run-123", status: "COMPLETED" };
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    await waitFor(() => {
      expect(mockRefetchGitStatus).toHaveBeenCalledTimes(1);
    });

    mockChatState.runId = "run-456";
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    expect(mockRefetchGitStatus).toHaveBeenCalledTimes(1);

    mockRunSummaryState.summary = { runId: "run-456", status: "COMPLETED" };
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    await waitFor(() => {
      expect(mockRefetchGitStatus).toHaveBeenCalledTimes(2);
    });
    expect(onSessionStatusChange).toHaveBeenCalledWith("completed");
  });

  it("ignores stale run summary state from a different runId", async () => {
    const onSessionStatusChange = vi.fn();
    const { rerender } = render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    mockRunSummaryState.summary = { runId: "run-old", status: "COMPLETED" };
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRefetchGitStatus).not.toHaveBeenCalled();
    expect(onSessionStatusChange).not.toHaveBeenCalledWith("completed");
    expect(onSessionStatusChange).not.toHaveBeenCalledWith("failed");
  });

  it("marks session as failed when canonical run status fails", async () => {
    const onSessionStatusChange = vi.fn();
    const { rerender } = render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    mockChatState.isLoading = true;
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    mockChatState.isLoading = false;
    mockRunSummaryState.summary = { runId: "run-123", status: "FAILED" };
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    await waitFor(() => {
      expect(onSessionStatusChange).toHaveBeenCalledWith("failed");
    });
  });

  it("marks session as paused when canonical run status pauses", async () => {
    const onSessionStatusChange = vi.fn();
    const { rerender } = render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    mockRunSummaryState.summary = { runId: "run-123", status: "PAUSED" };
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    await waitFor(() => {
      expect(onSessionStatusChange).toHaveBeenCalledWith("paused");
    });
  });

  it("marks session as failed when chat fails before a canonical run starts", async () => {
    const onSessionStatusChange = vi.fn();
    const { rerender } = render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    mockChatState.isLoading = true;
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    expect(onSessionStatusChange).toHaveBeenCalledWith("running");

    mockChatState.isLoading = false;
    mockChatState.error = "Session service is temporarily unavailable.";
    mockRunSummaryState.summary = null;
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    await waitFor(() => {
      expect(onSessionStatusChange).toHaveBeenCalledWith("failed");
    });
  });

  it("forces a fresh git status fetch after workspace bootstrap succeeds", async () => {
    mockGitHubTreeState.repo = {
      owner: { login: "Puneet-Pal-Singh" },
      name: "career-crew",
      full_name: "Puneet-Pal-Singh/career-crew",
      html_url: "https://github.com/Puneet-Pal-Singh/career-crew",
      default_branch: "main",
    };
    mockGitHubTreeState.isGitHubLoaded = true;

    render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="Puneet-Pal-Singh/career-crew"
      />,
    );

    await waitFor(() => {
      expect(mockBootstrapGitWorkspace).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockRefetchGitStatus).toHaveBeenCalledWith(true);
    });
  });

  it("reruns workspace bootstrap when known repository git state becomes unavailable", async () => {
    mockGitHubTreeState.repo = {
      owner: { login: "Puneet-Pal-Singh" },
      name: "career-crew",
      full_name: "Puneet-Pal-Singh/career-crew",
      html_url: "https://github.com/Puneet-Pal-Singh/career-crew",
      default_branch: "main",
    };
    mockGitHubTreeState.isGitHubLoaded = true;

    const { rerender } = render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="Puneet-Pal-Singh/career-crew"
      />,
    );

    await waitFor(() => {
      expect(mockBootstrapGitWorkspace).toHaveBeenCalledTimes(1);
    });

    mockBootstrapGitWorkspace.mockClear();
    mockGitStatusState.status = {
      ...mockGitStatusState.status,
      gitAvailable: false,
    };

    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="Puneet-Pal-Singh/career-crew"
      />,
    );

    await waitFor(() => {
      expect(mockBootstrapGitWorkspace).toHaveBeenCalledTimes(1);
    });
  });

  it("does not trigger workspace bootstrap while a run is actively loading", async () => {
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
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="Puneet-Pal-Singh/career-crew"
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockBootstrapGitWorkspace).not.toHaveBeenCalled();
  });

  it("does not fetch git status while a run is actively loading", () => {
    mockChatState.isLoading = true;

    render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="Puneet-Pal-Singh/career-crew"
      />,
    );

    const latestGitStatusInput =
      mockUseGitStatusInputs[mockUseGitStatusInputs.length - 1];
    expect(latestGitStatusInput).toEqual({
      runId: "run-123",
      sessionId: "session-123",
      enabled: false,
    });
  });

  it("does not trigger workspace bootstrap when repository context mismatches active workspace", async () => {
    mockGitHubTreeState.repo = {
      owner: { login: "Puneet-Pal-Singh" },
      name: "career-crew",
      full_name: "Puneet-Pal-Singh/career-crew",
      html_url: "https://github.com/Puneet-Pal-Singh/career-crew",
      default_branch: "main",
    };
    mockGitHubTreeState.isGitHubLoaded = true;
    mockGitHubTreeState.isContextMismatch = true;

    render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="Puneet-Pal-Singh/shadowbox"
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockBootstrapGitWorkspace).not.toHaveBeenCalled();
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
      <Workspace
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

  it("keeps chat input in loading/stop mode when canonical run is still running", () => {
    mockRunSummaryState.summary = { runId: "run-123", status: "RUNNING" };
    mockChatState.isLoading = false;

    render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
      />,
    );

    expect(mockChatInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        chatProps: expect.objectContaining({
          canStop: true,
          isLoading: true,
        }),
      }),
    );
  });

  it("maps pending approval summaries to a waiting session without loading controls", async () => {
    const onSessionStatusChange = vi.fn();
    mockRunSummaryState.summary = {
      runId: "run-123",
      status: "COMPLETED",
      pendingApproval: {
        requestId: "approval-1",
        runId: "run-123",
        origin: "agent",
        category: "shell_command",
        title: "Run command",
        reason: "Needs approval",
        actionFingerprint: "shell_command:test",
        availableDecisions: ["allow_once", "deny"],
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    };
    mockChatState.isLoading = false;

    const { rerender } = render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        isSessionRunning
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    expect(mockChatInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        chatProps: expect.objectContaining({
          canStop: false,
          isLoading: false,
        }),
      }),
    );
    await waitFor(() => {
      expect(onSessionStatusChange).toHaveBeenCalledWith(
        "waiting_for_approval",
      );
    });
    expect(mockRefetchGitStatus).toHaveBeenCalledTimes(1);

    onSessionStatusChange.mockClear();
    mockRefetchGitStatus.mockClear();

    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        isSessionRunning
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSessionStatusChange).not.toHaveBeenCalled();
    expect(mockRefetchGitStatus).not.toHaveBeenCalled();
  });

  it("clears loading when a stale active summary follows a finished assistant response", () => {
    const onSessionStatusChange = vi.fn();
    mockRunSummaryState.summary = { runId: "run-123", status: "RUNNING" };
    mockChatState.isLoading = false;
    mockChatState.messages = [
      { role: "user", content: "hey" },
      { role: "assistant", content: "Hello!" },
    ];

    render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        isSessionRunning
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    expect(mockChatInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        chatProps: expect.objectContaining({
          canStop: false,
          isLoading: false,
        }),
      }),
    );
    expect(onSessionStatusChange).toHaveBeenCalledWith("completed");
  });

  it("lets local loading state override a stale terminal summary", () => {
    mockRunSummaryState.summary = { runId: "run-123", status: "completed" };
    mockChatState.isLoading = true;

    render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        isSessionRunning
      />,
    );

    expect(mockChatInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        chatProps: expect.objectContaining({
          canStop: true,
          isLoading: true,
        }),
      }),
    );
  });

  it("shows loading controls when local session state is still running", () => {
    mockChatState.isLoading = false;
    mockRunSummaryState.summary = null;

    render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        isSessionRunning
      />,
    );

    expect(mockChatInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        chatProps: expect.objectContaining({
          canStop: true,
          isLoading: true,
        }),
      }),
    );
  });

  it("clears local running status when the user stops a stuck session", () => {
    const onSessionStatusChange = vi.fn();
    mockChatState.isLoading = false;
    mockRunSummaryState.summary = null;

    render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        isSessionRunning
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    const lastCall =
      mockChatInterface.mock.calls[mockChatInterface.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const props = lastCall?.[0] as {
      chatProps: { stop: () => void };
    };

    act(() => {
      props.chatProps.stop();
    });

    expect(mockChatState.stop).toHaveBeenCalled();
    expect(onSessionStatusChange).toHaveBeenCalledWith("completed");
  });

  it("opens the right sidebar when review focus is requested", () => {
    const setIsRightSidebarOpen = vi.fn();
    const { rerender } = render(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        setIsRightSidebarOpen={setIsRightSidebarOpen}
        reviewSidebarFocusRequest={0}
      />,
    );

    expect(setIsRightSidebarOpen).not.toHaveBeenCalled();

    rerender(
      <Workspace
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
});
