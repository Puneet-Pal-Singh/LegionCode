import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Message } from "@ai-sdk/react";
import type { GitStatusResponse, RunEvent } from "@repo/shared-types";
import { ChatInterface } from "./ChatInterface.js";
import { runApprovalPath } from "../../lib/platform-endpoints.js";

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
}));
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

vi.mock("./ChatInputBar.js", () => ({
  ChatInputBar: (props: unknown) => mockChatInputBar(props),
}));

vi.mock("./ChatBranchSelector.js", () => ({
  ChatBranchSelector: () => null,
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

vi.mock("../git/GitReviewContext", () => ({
  useGitReview: () => ({
    status: mockGitReviewState.status,
    selectedReviewComments: [],
    toggleReviewCommentSelected: vi.fn(),
    markReviewCommentsDispatching: vi.fn(),
    markReviewCommentsDispatched: vi.fn(),
    markReviewCommentsDispatchFailed: vi.fn(),
  }),
}));

vi.mock("../../lib/git-client.js", () => ({
  getGitDiff: (input: unknown) => mockGetGitDiff(input),
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

describe("ChatInterface", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockChatInputBar.mockClear();
    mockLogin.mockClear();
    mockRefreshSession.mockClear();
    mockGitReviewState.status = null;
    mockGetGitDiff.mockClear();
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
      expect(screen.getByText("1 Changed file")).toBeInTheDocument();
      expect(screen.getByText("index.tsx")).toBeInTheDocument();
      expect(screen.getByText("+5")).toBeInTheDocument();
      expect(screen.getByText("-1")).toBeInTheDocument();
    });
  });

  it("renders backend-provided approval decisions and resolves the selected decision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
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
          command: "git commit -m \"feat: update\"",
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

    expect(
      screen.getByText("Do you want me to commit repository changes?"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Permission mode" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat-input-bar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow for this session" }),
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
  });

  it("treats stale approval requests as already resolved", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "No pending approval request found." }), {
        status: 409,
      }),
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
          actionFingerprint: "shell_command:bash:{\"command\":\"pnpm test\"}",
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
        screen.queryByText("Do you want me to run this command?"),
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
          actionFingerprint: "shell_command:bash:{\"command\":\"pnpm test\"}",
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
      screen.getByRole("button", { name: "Allow for this session" }),
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
          actionFingerprint: "shell_command:bash:{\"command\":\"pnpm test\"}",
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
          actionFingerprint: "shell_command:bash:{\"command\":\"pnpm test\"}",
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
      screen.getByText("Do you want me to run a shell command?"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.queryByTestId("chat-input-bar")).not.toBeInTheDocument();
  });

  it("uses the simplified default permission prompt when title is not question-style", () => {
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
          actionFingerprint: "shell_command:bash:{\"command\":\"pnpm test\"}",
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

    expect(
      screen.getByText("Do you want me to run this command?"),
    ).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
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
          error: "Provider rate limit reached. Retry after cooldown or switch to another connected provider.",
          debugEvents: [],
        }}
        sessionId="session-1"
        mode="build"
      />,
    );

    expect(screen.getByText("Provider rate limit was reached.")).toBeInTheDocument();
    expect(
      screen.getByText("Switch to another connected provider or retry after rate limits reset."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch Provider" })).toBeInTheDocument();
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

    expect(screen.getByText("Your login session is missing or expired.")).toBeInTheDocument();
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
      screen.getByText("I updated the workflow UI to match the compact design."),
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
