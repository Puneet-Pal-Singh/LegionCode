import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Message } from "@ai-sdk/react";
import type { GitStatusResponse, RunEvent } from "@repo/shared-types";
import type { LifecycleProjection } from "../../services/lifecycle/LifecycleProjection";
import { ChatInterface } from "./ChatInterface.js";
import { runApprovalPath } from "../../lib/platform-endpoints.js";
import type { ReviewCommentDraft } from "../git/reviewComments.js";

const mockChatInputBar = vi.hoisted(() =>
  vi.fn((props: unknown) => {
    void props;
    return <div data-testid="chat-input-bar" />;
  }),
);
const mockLogin = vi.hoisted(() => vi.fn());
const mockRefreshSession = vi.hoisted(() => vi.fn(async () => undefined));
const mockGitReviewState = vi.hoisted(() => ({
  status: null as GitStatusResponse | null,
  selectedReviewComments: [] as ReviewCommentDraft[],
}));
const mockTurnLifecycleProjection = vi.hoisted(() => ({
  projection: null as LifecycleProjection | null,
  error: null as string | null,
}));
const mockOpenPromptArtifactReview = vi.hoisted(() => vi.fn());
const mockMarkReviewCommentsDispatching = vi.hoisted(() => vi.fn());
const mockMarkReviewCommentsDispatched = vi.hoisted(() => vi.fn());
const mockMarkReviewCommentsDispatchFailed = vi.hoisted(() => vi.fn());
const mockGetGitDiff = vi.hoisted(() =>
  vi.fn(async (input?: unknown) => {
    void input;
    return {
      oldPath: "src/index.tsx",
      newPath: "src/index.tsx",
      hunks: [],
      isBinary: false,
      isNewFile: false,
      isDeleted: false,
    };
  }),
);
const mockGetEditArtifactDiff = vi.hoisted(() =>
  vi.fn(async (input?: unknown) => {
    void input;
    return {
      diff: {
        oldPath: "src/components/Hero.tsx",
        newPath: "src/components/Hero.tsx",
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            header: "@@ -1 +1 @@",
            lines: [
              {
                type: "added" as const,
                content: "+ saved artifact change",
                newLineNumber: 1,
              },
            ],
          },
        ],
        isBinary: false,
        isNewFile: false,
        isDeleted: false,
      },
    };
  }),
);
const mockGetEditArtifactReviewSourceByMessage = vi.hoisted(() =>
  vi.fn(async () => null),
);

vi.mock("./ChatInputBar.js", () => ({
  ChatInputBar: (props: unknown) => mockChatInputBar(props),
}));

vi.mock("../provider/ProviderDialog.js", () => ({
  ProviderDialog: () => null,
}));

vi.mock("../../hooks/useRunSummary.js", () => ({
  useRunSummary: vi.fn(),
}));

vi.mock("../../hooks/useRunEvents.js", () => ({
  useRunEvents: vi.fn(() => ({ events: [] })),
}));

vi.mock("../../hooks/useRunActivityFeed.js", () => ({
  useRunActivityFeed: vi.fn(() => ({ feed: null })),
}));

vi.mock("../../hooks/useTurnLifecycleProjection.js", () => ({
  useTurnLifecycleProjection: vi.fn(() => ({
    projection: mockTurnLifecycleProjection.projection,
    error: mockTurnLifecycleProjection.error,
  })),
}));

vi.mock("../../hooks/useProviderStore.js", () => ({
  useProviderStore: vi.fn(() => ({ providerModels: {} })),
}));

vi.mock("../../contexts/AuthContext.js", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
    login: mockLogin,
    logout: vi.fn(),
    refreshSession: mockRefreshSession,
  }),
}));

vi.mock("../git/useGitReview", () => ({
  useGitReview: () => ({
    status: mockGitReviewState.status,
    selectedReviewComments: mockGitReviewState.selectedReviewComments,
    openPromptArtifactReview: mockOpenPromptArtifactReview,
    toggleReviewCommentSelected: vi.fn(),
    markReviewCommentsDispatching: mockMarkReviewCommentsDispatching,
    markReviewCommentsDispatched: mockMarkReviewCommentsDispatched,
    markReviewCommentsDispatchFailed: mockMarkReviewCommentsDispatchFailed,
  }),
}));

vi.mock("../../lib/git-client.js", () => ({
  getGitDiff: (input: unknown) => mockGetGitDiff(input),
}));

vi.mock("../../lib/edit-artifacts-client.js", () => ({
  getEditArtifactDiff: (input: unknown) => mockGetEditArtifactDiff(input),
  getEditArtifactReviewSourceByMessage: () =>
    mockGetEditArtifactReviewSourceByMessage(),
}));

const mockDispatchRunSummaryRefresh = vi.fn();
vi.mock("../../lib/run-summary-events.js", () => ({
  RUN_SUMMARY_REFRESH_EVENT: "shadowbox:run-summary:refresh",
  dispatchRunSummaryRefresh: (...args: unknown[]) =>
    mockDispatchRunSummaryRefresh(...args),
}));

import { useRunSummary } from "../../hooks/useRunSummary.js";
import { useRunEvents } from "../../hooks/useRunEvents.js";
import { useRunActivityFeed } from "../../hooks/useRunActivityFeed.js";

function buildTerminalProjection(turnId: string): LifecycleProjection {
  const typedTurnId = turnId as LifecycleProjection["turnId"];
  return {
    turnId: typedTurnId,
    lastSequence: 3,
    items: [],
    pendingApproval: null,
    terminal: {
      state: "completed",
      eventId: "evt_terminal001",
      content: "Turn completed.\nReview the canonical turn diff.",
      occurredAt: "2026-03-24T10:00:03.000Z",
    },
    turnDiff: {
      turnId: typedTurnId,
      startSnapshot: {
        turnId: typedTurnId,
        snapshotKey: "start",
        treeId: "a".repeat(40),
        headSha: "b".repeat(40),
        phase: "start",
        capturedAt: "2026-03-24T10:00:00.000Z",
      },
      terminalSnapshot: {
        turnId: typedTurnId,
        snapshotKey: "terminal",
        treeId: "c".repeat(40),
        headSha: "d".repeat(40),
        phase: "terminal",
        capturedAt: "2026-03-24T10:00:03.000Z",
      },
      files: [
        {
          path: "src/components/Hero.tsx",
          status: "modified",
          additions: 3,
          deletions: 1,
          previousPath: null,
        },
        {
          path: "src/routes/agents.tsx",
          status: "modified",
          additions: 5,
          deletions: 2,
          previousPath: null,
        },
      ],
      patch: "diff --git a/src/components/Hero.tsx b/src/components/Hero.tsx\n",
    },
    activeThinking: false,
    assistantText: "",
  };
}

describe("ChatInterface", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockChatInputBar.mockClear();
    mockLogin.mockClear();
    mockRefreshSession.mockClear();
    mockGitReviewState.status = null;
    mockGitReviewState.selectedReviewComments = [];
    mockTurnLifecycleProjection.projection = null;
    mockTurnLifecycleProjection.error = null;
    mockGetGitDiff.mockClear();
    mockGetEditArtifactDiff.mockClear();
    mockGetEditArtifactReviewSourceByMessage.mockClear();
    mockOpenPromptArtifactReview.mockReset();
    mockMarkReviewCommentsDispatching.mockReset();
    mockMarkReviewCommentsDispatched.mockReset();
    mockMarkReviewCommentsDispatchFailed.mockReset();
    mockDispatchRunSummaryRefresh.mockReset();
    vi.mocked(useRunEvents).mockReturnValue({ events: [] });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-1",
        status: "COMPLETED",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: {
          id: "run-1:plan",
          createdAt: "2026-03-24T10:00:00.000Z",
          summary: "Inspect the repository and then execute the build flow.",
          estimatedSteps: 2,
          tasks: [],
          handoff: {
            targetMode: "build",
            summary: "Move to build with the approved handoff prompt.",
            prompt: "Execute this approved plan in build mode.",
          },
        },
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId: "run-1",
        sessionId: "session-1",
        status: "COMPLETED",
        items: [
          {
            id: "text-1",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "text",
            createdAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:00.000Z",
            source: "brain",
            role: "user",
            content: "Plan this repository.",
          },
          {
            id: "reasoning-1",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "reasoning",
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:01.000Z",
            source: "brain",
            label: "Preparing handoff",
            summary: "Finalizing the approved plan.",
            phase: "planning",
            status: "completed",
          },
          {
            id: "handoff-1",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "handoff",
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:01.000Z",
            source: "brain",
            targetMode: "build",
            summary: "Move to build with the approved handoff prompt.",
            prompt: "Execute this approved plan in build mode.",
            status: "ready",
          },
        ],
      },
    });
  });

  it("keeps the welcome composer hidden while transcript hydration is pending", () => {
    vi.mocked(useRunActivityFeed).mockReturnValue({ feed: null });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          hasHydrated: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(
      screen.getByRole("status", { name: "Loading conversation" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading conversation")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Conversation unavailable"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("What should we build?")).not.toBeInTheDocument();
  });

  it("uses an icon-only placeholder for a started session with no hydrated transcript", () => {
    vi.mocked(useRunActivityFeed).mockReturnValue({ feed: null });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          hasHydrated: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        hasStartedSession
        mode="build"
      />,
    );

    expect(
      screen.getByRole("status", { name: "Loading conversation" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Conversation unavailable"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Loading conversation")).not.toBeInTheDocument();
    expect(screen.queryByText("What should we build?")).not.toBeInTheDocument();
  });

  it("renders activity-only turns when transcript messages are missing", () => {
    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          hasHydrated: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        hasStartedSession
        mode="build"
      />,
    );

    expect(screen.getByText("Plan this repository.")).toBeInTheDocument();
    expect(screen.getByText(/Worked for/)).toBeInTheDocument();
    expect(screen.queryByText("What should we build?")).not.toBeInTheDocument();
  });

  it("does not render a completed terminal fallback when an assistant message is visible", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-terminal",
        status: "COMPLETED",
        totalTasks: 1,
        completedTasks: 1,
        failedTasks: 0,
        terminalState: "completed",
        terminalMessage: {
          changedFileCount: 2,
          lastSuccessfulStep: "create_code_artifact",
          nextAction: "Send the next task when you are ready.",
        },
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({ feed: null });

    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "update the workflow UI",
            },
            {
              id: "assistant-progress",
              role: "assistant",
              content: "I found the relevant workflow files.",
            },
          ],
          runId: "run-terminal",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          hasHydrated: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        hasStartedSession
        mode="build"
      />,
    );

    expect(
      screen.getByText("I found the relevant workflow files."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Run completed\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/2 files changed\./)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Last successful step: create_code_artifact/),
    ).not.toBeInTheDocument();
  });

  it("settles the loading UI when the run summary is terminal", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-terminal",
        status: "COMPLETED",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        terminalState: "completed",
        terminalMessage: {
          changedFileCount: 0,
          nextAction: "Send the next task when you are ready.",
        },
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({ feed: null });

    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "yoyo",
            },
          ],
          runId: "run-terminal",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          canStop: true,
          isLoading: true,
          hasHydrated: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        hasStartedSession
        mode="build"
      />,
    );

    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.queryByText(/Run completed\./)).not.toBeInTheDocument();
    expect(mockChatInputBar).toHaveBeenLastCalledWith(
      expect.objectContaining({
        canStop: false,
        isLoading: false,
      }),
    );
  });

  it("caches missing artifact sources for assistant messages before terminal status", async () => {
    const messages: Message[] = [
      {
        id: "assistant-no-artifact",
        role: "assistant",
        content: "Plain response.",
      },
    ];
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-active",
        status: "RUNNING",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
      },
    });

    const { rerender } = render(
      <ChatInterface
        chatProps={{
          messages,
          runId: "run-active",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          hasHydrated: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    await waitFor(() => {
      expect(mockGetEditArtifactReviewSourceByMessage).toHaveBeenCalledTimes(1);
    });

    rerender(
      <ChatInterface
        chatProps={{
          messages: [...messages],
          runId: "run-active",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          hasHydrated: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockGetEditArtifactReviewSourceByMessage).toHaveBeenCalledTimes(1);
  });

  it("renders canonical terminal turn-diff files from lifecycle projection", async () => {
    const runId = "trn_terminal001";
    mockTurnLifecycleProjection.projection = buildTerminalProjection(runId);
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId,
        status: "COMPLETED",
        totalTasks: 1,
        completedTasks: 1,
        failedTasks: 0,
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId,
        sessionId: "session-1",
        status: "COMPLETED",
        items: [],
      },
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "assistant-progress",
              role: "assistant",
              content: "I found the relevant workflow files.",
            },
          ],
          runId,
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          hasHydrated: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        hasStartedSession
      />,
    );

    expect(screen.getAllByText(/2 files changed/i).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", {
        name: /expand changes for src\/components\/hero\.tsx/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /expand changes for src\/routes\/agents\.tsx/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("src/unused.ts")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: /expand changes for src\/components\/hero\.tsx/i,
      }),
    );

    await waitFor(() => {
      expect(mockGetGitDiff).toHaveBeenCalledWith({
        runId,
        sessionId: "session-1",
        path: "src/components/Hero.tsx",
        staged: false,
      });
    });
    expect(mockGetEditArtifactDiff).not.toHaveBeenCalled();
    expect(mockOpenPromptArtifactReview).not.toHaveBeenCalled();
  });

  it("replays provider interruption rows from hydrated transcript activity", () => {
    vi.mocked(useRunActivityFeed).mockReturnValue({ feed: null });

    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "check CI",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "The selected model stopped responding.",
              data: {
                activityParts: [
                  {
                    version: 1,
                    type: "turn_activity",
                    compacted: false,
                    events: [
                      {
                        id: "activity-provider",
                        runId: "run-1",
                        sessionId: "session-1",
                        turnId: "run-1:turn-1",
                        sequence: 1,
                        kind: "provider_error",
                        status: "paused",
                        title: "Provider interruption",
                        detail:
                          "The selected model stopped responding after retrying.",
                        displayMode: "visible",
                        metadata: {
                          code: "PROVIDER_UNAVAILABLE",
                          providerId: "google",
                          modelId: "gemma-4-31b-it",
                          statusCode: 500,
                        },
                        createdAt: "2026-05-24T00:00:00.000Z",
                        updatedAt: "2026-05-24T00:00:00.000Z",
                      },
                    ],
                  },
                ],
              },
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          hasHydrated: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        hasStartedSession
        mode="build"
      />,
    );

    expect(
      screen.getAllByText("The selected model stopped responding."),
    ).toHaveLength(2);
    expect(screen.getByText("View details")).toBeInTheDocument();
    expect(
      screen.queryByText("Recoverable provider interruption"),
    ).not.toBeInTheDocument();
  });

  it("keeps changed files on the final assistant message after git status becomes clean", async () => {
    const changedStatus: GitStatusResponse = {
      files: [
        {
          path: "src/components/landing/hero/index.tsx",
          status: "modified",
          additions: 5,
          deletions: 1,
          isStaged: false,
        },
      ],
      ahead: 0,
      behind: 0,
      branch: "main",
      hasStaged: false,
      hasUnstaged: true,
      gitAvailable: true,
    };
    const cleanStatus: GitStatusResponse = {
      ...changedStatus,
      files: [],
      hasUnstaged: false,
    };
    const messages: Message[] = [
      {
        id: "user-1",
        role: "user",
        content: "edit the hero",
      },
      {
        id: "assistant-final",
        role: "assistant",
        content: "I completed the requested update.",
      },
    ];
    mockGitReviewState.status = changedStatus;

    const { rerender } = render(
      <ChatInterface
        chatProps={{
          messages,
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    mockGitReviewState.status = cleanStatus;
    rerender(
      <ChatInterface
        chatProps={{
          messages,
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/1 file changed/i)).toBeInTheDocument();
      expect(screen.getByText("index.tsx")).toBeInTheDocument();
      expect(screen.getByText("+5")).toBeInTheDocument();
      expect(screen.getByText("-1")).toBeInTheDocument();
    });
  });

  it("attaches changed files that arrive after the assistant message settles", async () => {
    const changedStatus: GitStatusResponse = {
      files: [
        {
          path: "src/components/landing/hero/index.tsx",
          status: "modified",
          additions: 13,
          deletions: 18,
          isStaged: false,
        },
      ],
      ahead: 0,
      behind: 0,
      branch: "main",
      hasStaged: false,
      hasUnstaged: true,
      gitAvailable: true,
    };
    const messages: Message[] = [
      { id: "user-1", role: "user", content: "edit the hero" },
      {
        id: "assistant-final",
        role: "assistant",
        content: "I completed the requested update.",
      },
    ];
    mockGitReviewState.status = {
      ...changedStatus,
      files: [],
      hasUnstaged: false,
    };

    const { rerender } = render(
      <ChatInterface
        chatProps={{
          messages,
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    mockGitReviewState.status = changedStatus;
    rerender(
      <ChatInterface
        chatProps={{
          messages,
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/1 file changed/i)).toBeInTheDocument();
      expect(screen.getByText("index.tsx")).toBeInTheDocument();
      expect(screen.getByText("+13")).toBeInTheDocument();
      expect(screen.getByText("-18")).toBeInTheDocument();
    });
  });

  it("prefers grounded activity edit stats over live zero-count git status", async () => {
    mockGitReviewState.status = {
      files: [
        {
          path: "src/components/landing/hero/index.tsx",
          status: "modified",
          additions: 0,
          deletions: 0,
          isStaged: false,
        },
      ],
      ahead: 0,
      behind: 0,
      branch: "main",
      hasStaged: false,
      hasUnstaged: true,
      gitAvailable: true,
    };
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId: "run-1",
        sessionId: "session-1",
        status: "COMPLETED",
        items: [
          {
            id: "user-activity",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "text",
            createdAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:00.000Z",
            source: "brain",
            role: "user",
            content: "edit the hero",
          },
          {
            id: "edit-activity",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "tool",
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:02.000Z",
            source: "brain",
            toolId: "tool-1",
            toolName: "write_file",
            status: "completed",
            metadata: {
              family: "edit",
              filePath: "src/components/landing/hero/index.tsx",
              additions: 84,
              deletions: 74,
              diffPreview: "+ const heroTitle = 'Career Crew';",
            },
          },
        ],
      },
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [
            { id: "user-1", role: "user", content: "edit the hero" },
            {
              id: "assistant-final",
              role: "assistant",
              content: "I completed the requested update.",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/1 file changed/i)).toBeInTheDocument();
      expect(screen.getByText("+84")).toBeInTheDocument();
      expect(screen.getByText("-74")).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: /expand changes for src\/components\/landing\/hero\/index\.tsx/i,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("+ const heroTitle = 'Career Crew';"),
      ).toBeInTheDocument();
    });
  });

  it("shows only files changed during the current assistant turn", async () => {
    const footerStatus: GitStatusResponse = {
      files: [
        {
          path: "src/components/layout/Footer.tsx",
          status: "modified",
          additions: 9,
          deletions: 9,
          isStaged: false,
        },
      ],
      ahead: 0,
      behind: 0,
      branch: "main",
      hasStaged: false,
      hasUnstaged: true,
      gitAvailable: true,
    };
    const heroAndFooterStatus: GitStatusResponse = {
      ...footerStatus,
      files: [
        {
          path: "src/components/landing/hero/index.tsx",
          status: "modified",
          additions: 34,
          deletions: 23,
          isStaged: false,
        },
        ...footerStatus.files,
      ],
    };
    const messages: Message[] = [
      { id: "user-1", role: "user", content: "edit the footer" },
      { id: "assistant-1", role: "assistant", content: "Footer done." },
      { id: "user-2", role: "user", content: "add it to hero too" },
      { id: "assistant-2", role: "assistant", content: "Hero done." },
    ];
    mockGitReviewState.status = footerStatus;

    const { rerender } = render(
      <ChatInterface
        chatProps={{
          messages,
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    rerender(
      <ChatInterface
        chatProps={{
          messages,
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    mockGitReviewState.status = heroAndFooterStatus;
    rerender(
      <ChatInterface
        chatProps={{
          messages,
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/1 file changed/i)).toBeInTheDocument();
      expect(screen.getByText("index.tsx")).toBeInTheDocument();
      expect(screen.queryByText("Footer.tsx")).not.toBeInTheDocument();
    });
  });

  it("renders backend-provided approval decisions and resolves the selected decision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-approval",
        status: "WAITING",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
        permissionContext: {
          state: {
            productMode: "auto_for_safe",
            approvalPolicy: "ask_on_request",
            executionScope: "workspace_safe",
            workflowIntent: "ship",
          },
          label: "Default permissions",
          resolverInput: {
            runMode: "build",
            entrypoint: "composer_submit",
          },
          resolvedAt: "2026-01-01T00:00:00.000Z",
        },
        pendingApproval: {
          requestId: "req-1",
          runId: "run-approval",
          origin: "agent",
          category: "git_mutation",
          title: "LegionCode wants to commit repository changes",
          reason: "Git mutation actions can change repository history.",
          actionFingerprint: "git_mutation:git_commit:{}",
          command: 'git commit -m "feat: update"',
          availableDecisions: ["allow_once", "deny"],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-approval",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(screen.getAllByText("Pending approval")).toHaveLength(1);
    expect(
      screen.getByText("LegionCode wants to commit repository changes"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Permission mode" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat-input-bar")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Allow once" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow for this run" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow in future" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        runApprovalPath(),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
    expect(mockDispatchRunSummaryRefresh).toHaveBeenCalledWith("run-approval");
    expect(
      await screen.findByText("Approval recorded. Continuing..."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat-input-bar")).not.toBeInTheDocument();
  });

  it("treats stale approval requests as already resolved", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "No pending approval request found." }),
        {
          status: 409,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-stale-approval",
        status: "WAITING",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
        pendingApproval: {
          requestId: "req-stale",
          runId: "run-stale-approval",
          origin: "agent",
          category: "shell_command",
          title: "LegionCode wants to run a shell command",
          reason:
            "Shell commands can change repository or environment state and should be confirmed.",
          actionFingerprint: 'shell_command:bash:{"command":"pnpm test"}',
          command: "pnpm test",
          availableDecisions: ["allow_once", "deny"],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-stale-approval",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    await waitFor(() => {
      expect(mockDispatchRunSummaryRefresh).toHaveBeenCalledWith(
        "run-stale-approval",
      );
    });
    await waitFor(() => {
      expect(
        screen.queryByText("LegionCode wants to run a shell command"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("chat-input-bar")).toBeInTheDocument();
    expect(
      screen.queryByText("No pending approval request found."),
    ).not.toBeInTheDocument();
  });

  it("orders primary approval actions first but keeps additional actions visible", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-labels",
        status: "WAITING",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
        pendingApproval: {
          requestId: "req-labels",
          runId: "run-labels",
          origin: "agent",
          category: "shell_command",
          title: "LegionCode wants to run a shell command",
          reason:
            "Shell commands can change repository or environment state and should be confirmed.",
          actionFingerprint: 'shell_command:bash:{"command":"pnpm test"}',
          command: "pnpm test",
          availableDecisions: [
            "allow_once",
            "allow_for_run",
            "allow_persistent_rule",
            "deny",
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-labels",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Allow for this run" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Allow in future" }),
    ).toBeInTheDocument();
  });

  it("does not revive stale event-based approvals when summary reports no pending request", () => {
    const staleApprovalEvent: RunEvent = {
      version: 1,
      eventId: "evt-approval-requested",
      runId: "run-no-pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "brain",
      type: "approval.requested",
      payload: {
        request: {
          requestId: "req-stale-event",
          runId: "run-no-pending",
          origin: "agent",
          category: "shell_command",
          title: "LegionCode wants to run a shell command",
          reason:
            "Shell commands can change repository or environment state and should be confirmed.",
          actionFingerprint: 'shell_command:bash:{"command":"pnpm test"}',
          command: "pnpm test",
          availableDecisions: ["allow_once", "deny"],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-no-pending",
        status: "COMPLETED",
        totalTasks: 1,
        completedTasks: 1,
        failedTasks: 0,
        planArtifact: null,
        pendingApproval: null,
      },
    });
    vi.mocked(useRunEvents).mockReturnValue({
      events: [staleApprovalEvent],
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-no-pending",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Allow once" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-input-bar")).toBeInTheDocument();
  });

  it("subscribes to live run events while the chat run is active", () => {
    vi.mocked(useRunSummary).mockReturnValue({ summary: null });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-local-polling",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(useRunEvents).toHaveBeenCalledWith("run-local-polling", true);
  });

  it("shows event-based pending approval when summary is temporarily stale during an active run", () => {
    const pendingApprovalEvent: RunEvent = {
      version: 1,
      eventId: "evt-approval-requested-active",
      runId: "run-active-no-summary-pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "brain",
      type: "approval.requested",
      payload: {
        request: {
          requestId: "req-active-event",
          runId: "run-active-no-summary-pending",
          origin: "agent",
          category: "shell_command",
          title: "LegionCode wants to run a shell command",
          reason:
            "Shell commands can change repository or environment state and should be confirmed.",
          actionFingerprint: 'shell_command:bash:{"command":"pnpm test"}',
          command: "pnpm test",
          availableDecisions: ["allow_once", "deny"],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-active-no-summary-pending",
        status: "RUNNING",
        totalTasks: 1,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
        pendingApproval: null,
      },
    });
    vi.mocked(useRunEvents).mockReturnValue({
      events: [pendingApprovalEvent],
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-active-no-summary-pending",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(
      screen.getByText("LegionCode wants to run a shell command"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Allow once" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat-input-bar")).not.toBeInTheDocument();
  });

  it("shows unresolved event-based approval for approval-required terminal summaries", () => {
    const pendingApprovalEvent: RunEvent = {
      version: 1,
      eventId: "evt-approval-required-terminal",
      runId: "run-terminal-approval",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "brain",
      type: "approval.requested",
      payload: {
        request: {
          requestId: "req-terminal-approval",
          runId: "run-terminal-approval",
          origin: "agent",
          category: "git_mutation",
          title: "Create branch feat/demo-approval?",
          reason: "Branch creation changes repository state.",
          actionFingerprint: "git_mutation:create_branch:feat/demo-approval",
          command: "git checkout -b feat/demo-approval",
          availableDecisions: ["allow_once", "allow_for_run", "deny"],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-terminal-approval",
        status: "approval_required",
        totalTasks: 1,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
        pendingApproval: null,
      },
    });
    vi.mocked(useRunEvents).mockReturnValue({
      events: [pendingApprovalEvent],
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-terminal-approval",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(
      screen.getAllByText("Create branch feat/demo-approval?").length,
    ).toBe(1);
    expect(
      screen.getByRole("button", { name: "Allow for this run" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat-input-bar")).not.toBeInTheDocument();
  });

  it("renders the approval title and command in the dock", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-shell-prompt",
        status: "WAITING",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
        pendingApproval: {
          requestId: "req-shell-prompt",
          runId: "run-shell-prompt",
          origin: "agent",
          category: "shell_command",
          title: "Run shell command",
          reason:
            "Shell commands can change repository or environment state and should be confirmed.",
          actionFingerprint: 'shell_command:bash:{"command":"pnpm test"}',
          command: "pnpm test",
          availableDecisions: ["allow_once", "deny"],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-shell-prompt",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(screen.getByText("Run shell command")).toBeInTheDocument();
    expect(screen.getAllByText("pnpm test")).toHaveLength(1);
  });

  it("switches to build mode and stages the approved handoff prompt", async () => {
    const handleInputChange = vi.fn();
    const onModeChange = vi.fn();
    const append = vi.fn().mockResolvedValue(undefined);
    const messages: Message[] = [
      {
        id: "user-1",
        role: "user",
        content: "Plan this repository.",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Plan complete.",
      },
    ];

    render(
      <ChatInterface
        chatProps={{
          messages,
          runId: "run-1",
          input: "",
          handleInputChange,
          handleSubmit: vi.fn(),
          append,
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="plan"
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /worked for 1s/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "Execute Plan in Build" }),
    );

    expect(onModeChange).toHaveBeenCalledWith("build");
    expect(handleInputChange).not.toHaveBeenCalled();
    expect(screen.getByText("Worked for 1s")).toBeInTheDocument();

    await waitFor(() => {
      expect(append).not.toHaveBeenCalled();
    });
  });

  it("clears the composer immediately when submitting review comments", async () => {
    let resolveAppend: (() => void) | undefined;
    const append = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAppend = resolve;
        }),
    );
    const handleInputChange = vi.fn();
    mockGitReviewState.selectedReviewComments = [buildReviewCommentDraft()];

    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Make my hero page pretty.",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Done.",
            },
          ],
          runId: "run-1",
          input: "Check this?",
          handleInputChange,
          handleSubmit: vi.fn(),
          append,
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    const inputProps = latestChatInputBarProps();
    let submitPromise: boolean | void | Promise<boolean | void> = undefined;
    act(() => {
      submitPromise = inputProps.onSubmit();
    });

    expect(readLastInputChangeValue(handleInputChange)).toBe("");

    const finishAppend = resolveAppend;
    if (!finishAppend) {
      throw new Error("append promise was not created");
    }
    finishAppend();
    await submitPromise;

    expect(append).toHaveBeenCalledWith({
      role: "user",
      content: expect.stringContaining("Please address the following review comments:"),
    });
    expect(mockMarkReviewCommentsDispatched).toHaveBeenCalledWith([
      "comment-1",
    ]);
  });

  it("does not clobber composer text typed while review comment submission fails", async () => {
    let rejectAppend: ((error: Error) => void) | undefined;
    const append = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAppend = reject;
        }),
    );
    const handleInputChange = vi.fn();
    mockGitReviewState.selectedReviewComments = [buildReviewCommentDraft()];

    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Make my hero page pretty.",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Done.",
            },
          ],
          runId: "run-1",
          input: "Check this?",
          handleInputChange,
          handleSubmit: vi.fn(),
          append,
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    const inputProps = latestChatInputBarProps();
    let submitPromise: boolean | void | Promise<boolean | void> = undefined;
    act(() => {
      submitPromise = inputProps.onSubmit();
    });
    act(() => {
      inputProps.onChange("Do another thing");
    });

    const failAppend = rejectAppend;
    if (!failAppend) {
      throw new Error("append promise was not created");
    }
    await act(async () => {
      failAppend(new Error("send failed"));
      await submitPromise;
    });

    expect(readInputChangeValues(handleInputChange)).toEqual([
      "",
      "Do another thing",
    ]);
    expect(mockMarkReviewCommentsDispatchFailed).toHaveBeenCalledWith(
      ["comment-1"],
      { reselect: true },
    );
  });

  it("renders completed transcript rows without the workflow overview panel", () => {
    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Plan this repository.",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Plan complete.",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="plan"
        onModeChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /worked for 1s/i }));

    expect(screen.queryByText("Workflow overview")).not.toBeInTheDocument();
    expect(screen.getByText("Preparing handoff")).toBeInTheDocument();
    expect(screen.getByText("Build Handoff")).toBeInTheDocument();
  });

  it("hides the build handoff action when build mode cannot be reached", () => {
    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Plan this repository.",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Plan complete.",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="plan"
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Execute Plan in Build" }),
    ).not.toBeInTheDocument();
  });

  it("auto-switches back to build mode after recoverable planner failures in plan mode", () => {
    const onModeChange = vi.fn();

    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "hey",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content:
                "I couldn't generate a valid structured plan for this turn, so I stopped before running tools.",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="plan"
        onModeChange={onModeChange}
      />,
    );

    expect(onModeChange).toHaveBeenCalledWith("build");
    expect(onModeChange).toHaveBeenCalledTimes(1);
  });

  it("passes the active repository through to the chat input bar", () => {
    render(
      <ChatInterface
        chatProps={{
          messages: [],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
        repoTree={[{ path: "README.md", type: "blob", sha: "1" }]}
        isLoadingRepoTree
      />,
    );

    expect(mockChatInputBar).toHaveBeenCalledWith(
      expect.objectContaining({
        repoTree: [{ path: "README.md", type: "blob", sha: "1" }],
        isLoadingRepoTree: true,
      }),
    );
  });

  it("shows rate-limit errors next to the composer so they remain visible after auto-scroll", () => {
    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Check my landing page.",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error:
            "Provider rate limit reached. Retry after cooldown or switch to another connected provider.",
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(
      screen.getByText("Provider rate limit was reached."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Switch to another connected provider or retry after rate limits reset.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Switch Provider" }),
    ).toBeInTheDocument();
  });

  it("routes expired app-session recovery to login instead of provider setup", async () => {
    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "yoyo",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: "Your session is missing or expired. Log in again and retry.",
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(
      screen.getByText("Your login session is missing or expired."),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Log in again" }));

    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it("keeps each workflow turn attached to its matching user query", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-1",
        status: "COMPLETED",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId: "run-1",
        sessionId: "session-1",
        status: "COMPLETED",
        items: [
          {
            id: "turn-1-user",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "text",
            createdAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:00.000Z",
            source: "brain",
            role: "user",
            content: "hey",
          },
          {
            id: "turn-1-reasoning",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "reasoning",
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:01.000Z",
            source: "brain",
            label: "Thinking",
            summary: "Greeting the user.",
            phase: "planning",
            status: "completed",
          },
          {
            id: "turn-1-tool",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "tool",
            createdAt: "2026-03-24T10:00:02.000Z",
            updatedAt: "2026-03-24T10:00:03.000Z",
            source: "brain",
            toolId: "tool-1",
            toolName: "read_file",
            status: "completed",
            metadata: {
              family: "read",
              count: 1,
              truncated: false,
              loadedPaths: ["README.md"],
              path: "README.md",
            },
          },
          {
            id: "turn-2-user",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-2",
            kind: "text",
            createdAt: "2026-03-24T10:01:00.000Z",
            updatedAt: "2026-03-24T10:01:00.000Z",
            source: "brain",
            role: "user",
            content: "can you read my readme?",
          },
          {
            id: "turn-2-reasoning",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-2",
            kind: "reasoning",
            createdAt: "2026-03-24T10:01:01.000Z",
            updatedAt: "2026-03-24T10:01:01.000Z",
            source: "brain",
            label: "Thinking",
            summary: "Reviewing the repository.",
            phase: "planning",
            status: "completed",
          },
          {
            id: "turn-2-tool-1",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-2",
            kind: "tool",
            createdAt: "2026-03-24T10:01:02.000Z",
            updatedAt: "2026-03-24T10:01:03.000Z",
            source: "brain",
            toolId: "tool-2",
            toolName: "read_file",
            status: "completed",
            metadata: {
              family: "read",
              count: 1,
              truncated: false,
              loadedPaths: ["README.md"],
              path: "README.md",
            },
          },
          {
            id: "turn-2-tool-2",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-2",
            kind: "tool",
            createdAt: "2026-03-24T10:01:04.000Z",
            updatedAt: "2026-03-24T10:01:05.000Z",
            source: "brain",
            toolId: "tool-3",
            toolName: "grep",
            status: "completed",
            metadata: {
              family: "search",
              count: 1,
              truncated: false,
              loadedPaths: ["README.md"],
              path: "README.md",
              pattern: "Shadowbox",
            },
          },
        ],
      },
    });

    const { container } = render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "hey",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Hello! How can I help you today?",
            },
            {
              id: "user-2",
              role: "user",
              content: "can you read my readme?",
            },
            {
              id: "assistant-2",
              role: "assistant",
              content: "I read the README and summarized it.",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("Worked for 3s")).toBeGreaterThan(text.indexOf("hey"));
    expect(text.indexOf("Worked for 3s")).toBeLessThan(
      text.indexOf("Hello! How can I help you today?"),
    );
    expect(text.indexOf("Worked for 5s")).toBeGreaterThan(
      text.indexOf("can you read my readme?"),
    );
    expect(text.indexOf("Worked for 5s")).toBeLessThan(
      text.indexOf("I read the README and summarized it."),
    );
  });

  it("matches workflow turns when persisted prompts normalize file mentions", async () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-1",
        status: "COMPLETED",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId: "run-1",
        sessionId: "session-1",
        status: "COMPLETED",
        items: [
          {
            id: "turn-1-user",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "text",
            createdAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:00.000Z",
            source: "brain",
            role: "user",
            content: "lets upgrade our footer Footer.tsx",
          },
          {
            id: "turn-1-tool",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "tool",
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:05.000Z",
            source: "brain",
            toolId: "tool-1",
            toolName: "create_code_artifact",
            status: "completed",
            metadata: {
              family: "edit",
              filePath: "src/components/layout/Footer.tsx",
              additions: 126,
              deletions: 102,
            },
          },
        ],
      },
    });

    const { container } = render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "lets upgrade our footer @Footer.tsx",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Footer updated.",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("Worked for 5s")).toBeGreaterThan(
      text.indexOf("lets upgrade our footer"),
    );
    fireEvent.click(screen.getByRole("button", { name: /worked for 5s/i }));
    expect(
      screen.getByText("Edit src/components/layout/Footer.tsx"),
    ).toBeInTheDocument();
    expect(
      (container.textContent ?? "").indexOf(
        "Edit src/components/layout/Footer.tsx",
      ),
    ).toBeGreaterThan(
      (container.textContent ?? "").indexOf("lets upgrade our footer"),
    );
    await waitFor(() => {
      expect(screen.getByText(/1 file changed/i)).toBeInTheDocument();
      expect(screen.getByText("Footer.tsx")).toBeInTheDocument();
      expect(screen.getByText("+126")).toBeInTheDocument();
      expect(screen.getByText("-102")).toBeInTheDocument();
    });
  });

  it("suppresses intermediary assistant chatter and keeps the latest assistant reply for the turn", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-1",
        status: "RUNNING",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId: "run-1",
        sessionId: "session-1",
        status: "RUNNING",
        items: [
          {
            id: "turn-1-user",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "text",
            createdAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:00.000Z",
            source: "brain",
            role: "user",
            content: "make the workflow ui look like codex",
          },
          {
            id: "turn-1-reasoning",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "reasoning",
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:01.000Z",
            source: "brain",
            label: "Thinking",
            summary: "",
            phase: "execution",
            status: "active",
          },
        ],
      },
    });

    render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "make the workflow ui look like codex",
            },
            {
              id: "assistant-progress-1",
              role: "assistant",
              content: "I'm checking the current renderer first.",
            },
            {
              id: "assistant-progress-2",
              role: "assistant",
              content: "I've narrowed it down to the workflow lane.",
            },
            {
              id: "assistant-final",
              role: "assistant",
              content: "I updated the workflow UI to match the compact design.",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(
      screen.queryByText("I'm checking the current renderer first."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("I've narrowed it down to the workflow lane."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "I updated the workflow UI to match the compact design.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText(/Thinking \d+:\d{2}/)).not.toBeInTheDocument();
  });

  it("keeps repeated user prompts attached to distinct workflow turns", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-1",
        status: "COMPLETED",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId: "run-1",
        sessionId: "session-1",
        status: "COMPLETED",
        items: [
          {
            id: "turn-1-user",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "text",
            createdAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:00.000Z",
            source: "brain",
            role: "user",
            content: "hey",
          },
          {
            id: "turn-1-reasoning",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "reasoning",
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:01.000Z",
            source: "brain",
            label: "Thinking",
            summary: "Greeting the user.",
            phase: "planning",
            status: "completed",
          },
          {
            id: "turn-1-tool",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "tool",
            createdAt: "2026-03-24T10:00:02.000Z",
            updatedAt: "2026-03-24T10:00:03.000Z",
            source: "brain",
            toolId: "tool-1",
            toolName: "read_file",
            status: "completed",
            metadata: {
              family: "read",
              count: 1,
              truncated: false,
              loadedPaths: ["README.md"],
              path: "README.md",
            },
          },
          {
            id: "turn-2-user",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-2",
            kind: "text",
            createdAt: "2026-03-24T10:01:00.000Z",
            updatedAt: "2026-03-24T10:01:00.000Z",
            source: "brain",
            role: "user",
            content: "hey",
          },
          {
            id: "turn-2-reasoning",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-2",
            kind: "reasoning",
            createdAt: "2026-03-24T10:01:01.000Z",
            updatedAt: "2026-03-24T10:01:01.000Z",
            source: "brain",
            label: "Thinking",
            summary: "Reviewing the repository.",
            phase: "planning",
            status: "completed",
          },
          {
            id: "turn-2-tool-1",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-2",
            kind: "tool",
            createdAt: "2026-03-24T10:01:02.000Z",
            updatedAt: "2026-03-24T10:01:03.000Z",
            source: "brain",
            toolId: "tool-2",
            toolName: "read_file",
            status: "completed",
            metadata: {
              family: "read",
              count: 1,
              truncated: false,
              loadedPaths: ["README.md"],
              path: "README.md",
            },
          },
          {
            id: "turn-2-tool-2",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-2",
            kind: "tool",
            createdAt: "2026-03-24T10:01:04.000Z",
            updatedAt: "2026-03-24T10:01:05.000Z",
            source: "brain",
            toolId: "tool-3",
            toolName: "grep",
            status: "completed",
            metadata: {
              family: "search",
              count: 1,
              truncated: false,
              loadedPaths: ["README.md"],
              path: "README.md",
              pattern: "Shadowbox",
            },
          },
        ],
      },
    });

    const { container } = render(
      <ChatInterface
        chatProps={{
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "hey",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Hello! How can I help you today?",
            },
            {
              id: "user-2",
              role: "user",
              content: "hey",
            },
            {
              id: "assistant-2",
              role: "assistant",
              content: "I read the README and summarized it.",
            },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    const text = container.textContent ?? "";
    const firstHeyIndex = text.indexOf("hey");
    const secondHeyIndex = text.indexOf("hey", firstHeyIndex + 1);

    expect(firstHeyIndex).toBeGreaterThan(-1);
    expect(secondHeyIndex).toBeGreaterThan(firstHeyIndex);
    expect(text.indexOf("Worked for 3s")).toBeGreaterThan(firstHeyIndex);
    expect(text.indexOf("Worked for 3s")).toBeLessThan(
      text.indexOf("Hello! How can I help you today?"),
    );
    expect(text.indexOf("Worked for 5s")).toBeGreaterThan(secondHeyIndex);
    expect(text.indexOf("Worked for 5s")).toBeLessThan(
      text.indexOf("I read the README and summarized it."),
    );
  });

  it("does not shift a later workflow turn upward when an intermediate query has no visible activity", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-1",
        status: "COMPLETED",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId: "run-1",
        sessionId: "session-1",
        status: "COMPLETED",
        items: [
          {
            id: "turn-1-user",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "text",
            createdAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:00.000Z",
            source: "brain",
            role: "user",
            content: "first query",
          },
          {
            id: "turn-1-tool",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "tool",
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:03.000Z",
            source: "brain",
            toolId: "tool-1",
            toolName: "read_file",
            status: "completed",
            metadata: {
              family: "read",
              count: 1,
              truncated: false,
              loadedPaths: ["README.md"],
              path: "README.md",
            },
          },
          {
            id: "turn-2-user",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-2",
            kind: "text",
            createdAt: "2026-03-24T10:01:00.000Z",
            updatedAt: "2026-03-24T10:01:00.000Z",
            source: "brain",
            role: "user",
            content: "second query",
          },
          {
            id: "turn-3-user",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-3",
            kind: "text",
            createdAt: "2026-03-24T10:02:00.000Z",
            updatedAt: "2026-03-24T10:02:00.000Z",
            source: "brain",
            role: "user",
            content: "third query",
          },
          {
            id: "turn-3-tool",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-3",
            kind: "tool",
            createdAt: "2026-03-24T10:02:01.000Z",
            updatedAt: "2026-03-24T10:02:05.000Z",
            source: "brain",
            toolId: "tool-3",
            toolName: "git_status",
            status: "completed",
            metadata: {
              family: "git",
              count: 1,
              preview: '{"ahead":0}',
            },
          },
        ],
      },
    });

    const { container } = render(
      <ChatInterface
        chatProps={{
          messages: [
            { id: "user-1", role: "user", content: "first query" },
            { id: "assistant-1", role: "assistant", content: "first reply" },
            { id: "user-2", role: "user", content: "second query" },
            { id: "assistant-2", role: "assistant", content: "second reply" },
            { id: "user-3", role: "user", content: "third query" },
            { id: "assistant-3", role: "assistant", content: "third reply" },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: false,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("Worked for 3s")).toBeGreaterThan(
      text.indexOf("first query"),
    );
    expect(text.indexOf("Worked for 3s")).toBeLessThan(
      text.indexOf("first reply"),
    );
    expect(text.indexOf("Worked for 5s")).toBeGreaterThan(
      text.indexOf("third query"),
    );
    expect(text.indexOf("Worked for 5s")).toBeLessThan(
      text.indexOf("third reply"),
    );
    expect(text.indexOf("Worked for 5s")).toBeGreaterThan(
      text.indexOf("second reply"),
    );
  });

  it("does not attach uncorrelated workflow activity to the latest user query", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-1",
        status: "RUNNING",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId: "run-1",
        sessionId: "session-1",
        status: "RUNNING",
        items: [
          {
            id: "orphan-tool",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-orphan",
            kind: "tool",
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:04.000Z",
            source: "brain",
            toolId: "tool-orphan",
            toolName: "read_file",
            status: "completed",
            metadata: {
              family: "read",
              count: 1,
              truncated: false,
              loadedPaths: ["README.md"],
              path: "README.md",
            },
          },
        ],
      },
    });

    const { container } = render(
      <ChatInterface
        chatProps={{
          messages: [
            { id: "user-1", role: "user", content: "second chat prompt" },
          ],
          runId: "run-1",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(container.textContent ?? "").not.toContain("Worked for 3s");
    expect(container.textContent ?? "").not.toContain("Read README.md");
  });

  it("attaches a recycled run's turn-1 workflow to the latest matching user query", () => {
    vi.mocked(useRunSummary).mockReturnValue({
      summary: {
        runId: "run-2",
        status: "RUNNING",
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        planArtifact: null,
      },
    });
    vi.mocked(useRunActivityFeed).mockReturnValue({
      feed: {
        runId: "run-2",
        sessionId: "session-1",
        status: "RUNNING",
        items: [
          {
            id: "run-2-user",
            runId: "run-2",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "text",
            createdAt: "2026-03-24T10:10:00.000Z",
            updatedAt: "2026-03-24T10:10:00.000Z",
            source: "brain",
            role: "user",
            content: "check my hero page do you liked it?",
          },
          {
            id: "run-2-tool-1",
            runId: "run-2",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "tool",
            createdAt: "2026-03-24T10:10:01.000Z",
            updatedAt: "2026-03-24T10:10:03.000Z",
            source: "brain",
            toolId: "tool-1",
            toolName: "list_files",
            status: "completed",
            metadata: {
              family: "read",
              count: 1,
              truncated: false,
              loadedPaths: ["src/app"],
              path: "src/app",
            },
          },
        ],
      },
    });

    const { container } = render(
      <ChatInterface
        chatProps={{
          messages: [
            { id: "user-1", role: "user", content: "hey" },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Hello! I'm here to help you with your project.",
            },
            {
              id: "user-2",
              role: "user",
              content: "check my hero page do you liked it?",
            },
          ],
          runId: "run-2",
          input: "",
          handleInputChange: vi.fn(),
          handleSubmit: vi.fn(),
          append: vi.fn(),
          stop: vi.fn(),
          isLoading: true,
          error: null,
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("List src/app")).toBeGreaterThan(
      text.indexOf("check my hero page do you liked it?"),
    );
    expect(text.indexOf("List src/app")).toBeGreaterThan(
      text.indexOf("Hello! I'm here to help you with your project."),
    );
  });
});

function latestChatInputBarProps(): {
  onSubmit: () => boolean | void | Promise<boolean | void>;
  onChange: (value: string) => void;
} {
  const lastCall =
    mockChatInputBar.mock.calls[mockChatInputBar.mock.calls.length - 1];
  if (!lastCall) {
    throw new Error("ChatInputBar was not rendered");
  }
  return lastCall[0] as {
    onSubmit: () => boolean | void | Promise<boolean | void>;
    onChange: (value: string) => void;
  };
}

function readInputChangeValues(handleInputChange: ReturnType<typeof vi.fn>) {
  return handleInputChange.mock.calls.map((call) => {
    const event = call[0] as { target?: { value?: unknown } } | undefined;
    return event?.target?.value;
  });
}

function readLastInputChangeValue(handleInputChange: ReturnType<typeof vi.fn>) {
  const lastCall =
    handleInputChange.mock.calls[handleInputChange.mock.calls.length - 1];
  const event = lastCall?.[0] as
    | { target?: { value?: unknown } }
    | undefined;
  return event?.target?.value;
}

function buildReviewCommentDraft(): ReviewCommentDraft {
  const anchor = {
    hunkIndex: 0,
    lineIndex: 0,
    rowKey: "0:0",
    newLineNumber: 152,
    side: "right" as const,
    linePreview: "className=\"absolute bottom-1/3\"",
  };

  return {
    id: "comment-1",
    filePath: "src/components/landing/hero/index.tsx",
    line: 152,
    side: "right",
    note: "Check if this class CSS is correct?",
    createdAt: "2026-06-16T08:53:00.000Z",
    linePreview: anchor.linePreview,
    selected: true,
    anchors: [anchor],
    primaryAnchor: anchor,
    selectionMode: "single",
    runId: "run-1",
    sessionId: "session-1",
    diffFingerprint: "fingerprint-1",
    stale: false,
    deliveryState: "draft",
  };
}
