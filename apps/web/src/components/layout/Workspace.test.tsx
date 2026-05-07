import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { Workspace } from "./Workspace";

const mockRefetchGitStatus = vi.hoisted(() => vi.fn(async () => {}));
const mockBootstrapGitWorkspace = vi.hoisted(() => vi.fn());
const mockChatState = vi.hoisted(() => ({
  messages: [],
  input: "",
  handleInputChange: vi.fn(),
  handleSubmit: vi.fn(),
  append: vi.fn(),
  stop: vi.fn(),
  isLoading: false,
  isHydrating: false,
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
  summary: null as { runId: string; status: string | null } | null,
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
  useGitStatus: () => ({
    status: {
      branch: "main",
      files: [],
      ahead: 0,
      behind: 0,
      hasStaged: false,
      hasUnstaged: false,
      gitAvailable: true,
    },
    refetch: mockRefetchGitStatus,
  }),
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
    setActiveTab: vi.fn(),
    sidebarWidth: 320,
    setSidebarWidth: vi.fn(),
    isResizing: false,
    setIsResizing: vi.fn(),
    selectedFile: null,
    setSelectedFile: vi.fn(),
    selectedDiff: null,
    setSelectedDiff: vi.fn(),
    isViewingContent: false,
    setIsViewingContent: vi.fn(),
    isLoadingContent: false,
    setIsLoadingContent: vi.fn(),
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
    stagedFiles: new Set<string>(),
    commitMessage: "",
    reviewComments: [],
    selectedReviewComments: [],
    selectedReviewCommentCount: 0,
    selectedReviewCommentsForFile: [],
    currentDiffFingerprint: null,
    reviewScope: "git-changes",
    setReviewScope: vi.fn(),
    openReview: vi.fn(),
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
    mockChatState.stop.mockClear();
    mockBootstrapGitWorkspace.mockReset();
    mockBootstrapGitWorkspace.mockResolvedValue({ status: "ready" });
    mockChatState.isLoading = false;
    mockChatState.runId = "run-123";
    mockChatState.error = null;
    mockRunSummaryState.summary = null;
    mockGitHubTreeState.repo = null;
    mockGitHubTreeState.branch = "main";
    mockGitHubTreeState.switchBranch.mockClear();
    mockGitHubTreeState.isGitHubLoaded = false;
    mockGitHubTreeState.isContextMismatch = false;
  });

  it("refreshes git status only when canonical run status reaches terminal", async () => {
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
    mockRunSummaryState.summary = { runId: "run-123", status: "RUNNING" };
    rerender(
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        onSessionStatusChange={onSessionStatusChange}
      />,
    );

    expect(onSessionStatusChange).not.toHaveBeenCalledWith("completed");
    expect(mockRefetchGitStatus).not.toHaveBeenCalled();

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
    expect(onSessionStatusChange).not.toHaveBeenCalledWith("error");
  });

  it("marks session as error when canonical run status fails", async () => {
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
      expect(onSessionStatusChange).toHaveBeenCalledWith("error");
    });
  });

  it("marks session as error when chat fails before a canonical run starts", async () => {
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
      expect(onSessionStatusChange).toHaveBeenCalledWith("error");
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

  it("keeps the stop button available when local session state is still running", () => {
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
          isLoading: false,
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

    const lastCall = mockChatInterface.mock.calls[mockChatInterface.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const props = lastCall?.[0] as {
      chatProps: { stop: () => void };
    };

    props.chatProps.stop();

    expect(mockChatState.stop).toHaveBeenCalled();
    expect(onSessionStatusChange).toHaveBeenCalledWith("completed");
  });
});
