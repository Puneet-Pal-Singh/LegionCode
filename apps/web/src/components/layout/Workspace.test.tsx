import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { Workspace } from "./Workspace";
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
    mockChatState.append.mockResolvedValue(undefined);
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

  it("submits an initial setup prompt once across workspace remounts", async () => {
    clearInitialPromptSubmissionClaimsForTests();
    mockChatState.append.mockResolvedValue(undefined);
    const onInitialPromptHandled = vi.fn();
    const initialPromptSubmission = {
      id: createInitialPromptSubmissionId("setup-prompt-1"),
      prompt:
        "Hey, read my readme and tell what do you think of this project??",
    };
    const firstRender = render(
      <Workspace
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
      <Workspace
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
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        initialPromptSubmission={initialPromptSubmission}
      />,
    );

    expect(mockChatState.append).not.toHaveBeenCalled();

    mockChatState.isModelConfigReady = true;
    rerender(
      <Workspace
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

  it("preserves setup-composer images in the first workspace message", async () => {
    clearInitialPromptSubmissionClaimsForTests();
    mockChatState.append.mockResolvedValue(undefined);
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
      <Workspace
        sessionId="session-123"
        runId="run-123"
        repository="career-crew"
        initialPromptSubmission={initialPromptSubmission}
      />,
    );

    await waitFor(() => {
      expect(mockChatState.append).toHaveBeenCalledWith({
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
      <Workspace
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

  it("passes SDK loading state directly to chat interface", () => {
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
          isLoading: false,
        }),
      }),
    );
  });

  it("passes SDK loading state even when summary is terminal", () => {
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
          isLoading: true,
        }),
      }),
    );
  });

  it("passes SDK loading state when no summary exists", () => {
    mockChatState.isLoading = false;

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
          isLoading: false,
        }),
      }),
    );
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

  it("opens the right sidebar review tab from a completed edit", () => {
    const onGitReviewOpenChange = vi.fn();
    const setIsRightSidebarOpen = vi.fn();
    render(
      <Workspace
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
