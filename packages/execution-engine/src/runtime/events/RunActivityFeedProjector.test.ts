import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PART_KINDS,
  RUN_EVENT_TYPES,
  TOOL_ACTIVITY_FAMILIES,
  type RunEvent,
} from "@repo/shared-types";
import { projectRunActivityFeed } from "./RunActivityFeedProjector.js";

describe("RunActivityFeedProjector", () => {
  it("projects reasoning, shell tool, and approval activity parts", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-1",
      run: {
        id: "run-1",
        sessionId: "session-1",
        status: "COMPLETED",
        metadata: {
          prompt: "Run tests",
          completedAt: "2026-03-24T10:00:03.000Z",
          lifecycleSteps: [
            {
              step: "APPROVAL_WAIT",
              recordedAt: "2026-03-24T10:00:02.000Z",
              detail: "platform approval required",
            },
          ],
          planArtifact: {
            id: "run-1:plan",
            createdAt: "2026-03-24T10:00:04.000Z",
            summary: "Build after review.",
            estimatedSteps: 1,
            tasks: [],
            handoff: {
              targetMode: "build",
              summary: "Switch to build mode.",
              prompt: "Execute the approved plan.",
            },
          },
        },
      },
      events: [
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "Run tests",
          role: "user",
        }),
        createEvent(RUN_EVENT_TYPES.RUN_STATUS_CHANGED, {
          previousStatus: "queued",
          newStatus: "running",
          workflowStep: "planning",
        }),
        createEvent(RUN_EVENT_TYPES.TOOL_REQUESTED, {
          toolId: "tool-1",
          toolName: "bash",
          arguments: { command: "pnpm test" },
          description: "Run pnpm test",
          displayText: "Running pnpm test",
        }),
        createEvent(RUN_EVENT_TYPES.TOOL_COMPLETED, {
          toolId: "tool-1",
          toolName: "bash",
          executionTimeMs: 1200,
          result: { content: "ok" },
        }),
      ],
    });

    expect(
      snapshot.items.some((item) => item.kind === ACTIVITY_PART_KINDS.TEXT),
    ).toBe(true);
    const reasoning = snapshot.items.find(
      (item) => item.kind === ACTIVITY_PART_KINDS.REASONING,
    );
    expect(reasoning?.kind).toBe("reasoning");

    const tool = snapshot.items.find(
      (item) => item.kind === ACTIVITY_PART_KINDS.TOOL,
    );
    expect(tool?.kind).toBe("tool");
    if (tool?.kind === "tool") {
      expect(tool.metadata.family).toBe(TOOL_ACTIVITY_FAMILIES.SHELL);
      expect(tool.status).toBe("completed");
      if (tool.metadata.family === TOOL_ACTIVITY_FAMILIES.SHELL) {
        expect(tool.metadata.description).toBe("Run pnpm test");
        expect(tool.metadata.displayText).toBe("Running pnpm test");
      }
    }

    expect(
      snapshot.items.some((item) => item.kind === ACTIVITY_PART_KINDS.APPROVAL),
    ).toBe(true);
    expect(
      snapshot.items.some((item) => item.kind === ACTIVITY_PART_KINDS.HANDOFF),
    ).toBe(false);
  });

  it("appends bounded shell output deltas onto the same bash row", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-1",
      run: null,
      events: [
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "run tests",
          role: "user",
        }),
        createEvent(RUN_EVENT_TYPES.TOOL_REQUESTED, {
          toolId: "tool-1",
          toolName: "bash",
          arguments: { command: "pnpm test" },
        }),
        createEvent(RUN_EVENT_TYPES.TOOL_STARTED, {
          toolId: "tool-1",
          toolName: "bash",
        }),
        createEvent(RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED, {
          toolId: "tool-1",
          toolName: "bash",
          stdoutDelta: "first line\n",
        }),
        createEvent(RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED, {
          toolId: "tool-1",
          toolName: "bash",
          stderrDelta: "second line\n",
        }),
      ],
    });

    const tool = snapshot.items.find(
      (item) => item.kind === ACTIVITY_PART_KINDS.TOOL,
    );
    expect(tool?.kind).toBe("tool");
    if (tool?.kind !== "tool" || tool.metadata.family !== "shell") {
      throw new Error("Expected shell tool activity part");
    }

    expect(tool.status).toBe("running");
    expect(tool.metadata.stdout).toContain("first line");
    expect(tool.metadata.stderr).toContain("second line");
    expect(tool.metadata.outputTail).toContain("[stderr]");
  });

  it("projects run.progress into reasoning rows and preserves assistant metadata", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-1",
      run: null,
      events: [
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "update footer",
          role: "user",
        }),
        createEvent(RUN_EVENT_TYPES.RUN_PROGRESS, {
          phase: "execution",
          label: "Thinking",
          summary: "Inspecting the workspace before answering.",
          status: "active",
        }),
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "No file was changed before the timeout.",
          role: "assistant",
          metadata: {
            code: "TASK_EXECUTION_TIMEOUT",
            retryable: true,
          },
        }),
      ],
    });

    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: ACTIVITY_PART_KINDS.REASONING,
          label: "Thinking",
          summary: "Inspecting the workspace before answering.",
        }),
        expect.objectContaining({
          kind: ACTIVITY_PART_KINDS.COMMENTARY,
          metadata: {
            code: "TASK_EXECUTION_TIMEOUT",
            retryable: true,
          },
        }),
      ]),
    );
  });

  it("projects TASK_MODEL_NO_ACTION assistant messages as recovery commentary", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-106",
      run: null,
      events: [
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "update footer",
          role: "user",
        }),
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content:
            "The model did not return a usable next action for this edit request.",
          role: "assistant",
          metadata: {
            code: "TASK_MODEL_NO_ACTION",
            retryable: true,
            resumeActions: ["retry", "switch_model"],
          },
        }),
      ],
    });

    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: ACTIVITY_PART_KINDS.COMMENTARY,
          metadata: {
            code: "TASK_MODEL_NO_ACTION",
            retryable: true,
            resumeActions: ["retry", "switch_model"],
          },
        }),
      ]),
    );
  });

  it("projects assistant final messages into commentary items with transcript phase metadata", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-3",
      run: null,
      events: [
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "fix the footer",
          role: "user",
          transcriptPhase: "prompt",
          transcriptStatus: "completed",
        }),
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "Footer updated.",
          role: "assistant",
          transcriptPhase: "final_answer",
          transcriptStatus: "completed",
        }),
      ],
    });

    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: ACTIVITY_PART_KINDS.COMMENTARY,
          phase: "final_answer",
          status: "completed",
          text: "Footer updated.",
        }),
      ]),
    );
  });

  it("projects assistant commentary messages into commentary items before tool execution", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-4",
      run: null,
      events: [
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "fix the footer",
          role: "user",
          transcriptPhase: "prompt",
          transcriptStatus: "completed",
        }),
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "I found the footer file and I'm going to edit it next.",
          role: "assistant",
          transcriptPhase: "commentary",
          transcriptStatus: "completed",
        }),
      ],
    });

    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: ACTIVITY_PART_KINDS.COMMENTARY,
          phase: "commentary",
          status: "completed",
          text: "I found the footer file and I'm going to edit it next.",
        }),
      ]),
    );
  });

  it("derives action-specific display text for read tools when the request payload is plain", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-2",
      run: null,
      events: [
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "read the README",
          role: "user",
        }),
        createEvent(RUN_EVENT_TYPES.TOOL_REQUESTED, {
          toolId: "tool-1",
          toolName: "read_file",
          arguments: { path: "README.md" },
        }),
      ],
    });

    const tool = snapshot.items.find(
      (item) => item.kind === ACTIVITY_PART_KINDS.TOOL,
    );
    expect(tool?.kind).toBe("tool");
    if (tool?.kind !== "tool" || tool.metadata.family !== "read") {
      throw new Error("Expected read tool activity part");
    }

    expect(tool.metadata.displayText).toBe("Reading README.md");
  });

  it("projects dedicated git actions as git-family rows with a GitHub plugin label", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-git",
      run: null,
      events: [
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "commit the hero changes",
          role: "user",
        }),
        createEvent(RUN_EVENT_TYPES.TOOL_REQUESTED, {
          toolId: "tool-git-commit",
          toolName: "git_commit",
          arguments: {
            message: "feat: add floating carousels to hero section",
          },
        }),
      ],
    });

    const tool = snapshot.items.find(
      (item) =>
        item.kind === ACTIVITY_PART_KINDS.TOOL &&
        item.toolName === "git_commit",
    );
    expect(tool?.kind).toBe("tool");
    if (
      tool?.kind !== "tool" ||
      tool.metadata.family !== TOOL_ACTIVITY_FAMILIES.GIT
    ) {
      throw new Error("Expected git tool activity part");
    }

    expect(tool.metadata.pluginLabel).toBe("GitHub");
  });

  it("projects approval requested and resolved events into a single approval row", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-approval",
      run: null,
      events: [
        createEvent(RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          content: "commit the current changes",
          role: "user",
        }),
        createEvent(RUN_EVENT_TYPES.APPROVAL_REQUESTED, {
          request: {
            requestId: "req-1",
            runId: "run-approval",
            origin: "agent",
            category: "git_mutation",
            title: "LegionCode wants to commit repository changes",
            reason: "Git mutation actions can change repository history.",
            actionFingerprint: "git_mutation:git_commit:{}",
            availableDecisions: ["allow_once", "deny"],
            createdAt: "2026-03-24T10:00:00.000Z",
          },
        }),
        createEvent(RUN_EVENT_TYPES.APPROVAL_RESOLVED, {
          requestId: "req-1",
          decision: "deny",
          status: "denied",
          resolvedAt: "2026-03-24T10:00:01.000Z",
        }),
      ],
    });

    const approvalItems = snapshot.items.filter(
      (item) => item.kind === ACTIVITY_PART_KINDS.APPROVAL,
    );
    expect(approvalItems).toHaveLength(1);
    const [approval] = approvalItems;
    expect(approval?.kind).toBe("approval");
    if (approval?.kind !== "approval") {
      throw new Error("Expected approval activity part");
    }

    expect(approval.status).toBe("denied");
    expect(approval.summary).toBe("Approval denied");
    expect(approval.details).toContain("Decision: deny");
  });

  it("does not duplicate approval decision details when duplicate resolved events arrive", () => {
    const snapshot = projectRunActivityFeed({
      runId: "run-approval-duplicate",
      run: null,
      events: [
        createEvent(RUN_EVENT_TYPES.APPROVAL_REQUESTED, {
          request: {
            requestId: "req-dup",
            runId: "run-approval-duplicate",
            origin: "agent",
            category: "shell_command",
            title: "LegionCode wants to run a shell command",
            reason: "Shell commands can change repository state.",
            actionFingerprint: "shell:pnpm test",
            availableDecisions: ["allow_once", "deny"],
            createdAt: "2026-03-24T10:00:00.000Z",
          },
        }),
        createEvent(RUN_EVENT_TYPES.APPROVAL_RESOLVED, {
          requestId: "req-dup",
          decision: "allow_once",
          status: "approved",
          resolvedAt: "2026-03-24T10:00:01.000Z",
        }),
        createEvent(RUN_EVENT_TYPES.APPROVAL_RESOLVED, {
          requestId: "req-dup",
          decision: "allow_once",
          status: "approved",
          resolvedAt: "2026-03-24T10:00:02.000Z",
        }),
      ],
    });

    const approval = snapshot.items.find(
      (item) =>
        item.kind === ACTIVITY_PART_KINDS.APPROVAL &&
        item.id === "approval:req-dup",
    );
    expect(approval?.kind).toBe("approval");
    if (approval?.kind !== "approval") {
      throw new Error("Expected approval activity part");
    }

    expect(approval.summary).toBe("Approval resolved");
    expect(approval.details).toBe(
      "Shell commands can change repository state.\nDecision: allow_once",
    );
  });
});

function createEvent<T extends RunEvent["type"]>(
  type: T,
  payload: Extract<RunEvent, { type: T }>["payload"],
): Extract<RunEvent, { type: T }> {
  return {
    version: 1,
    eventId: `${type}-event`,
    runId: "run-1",
    sessionId: "session-1",
    timestamp: "2026-03-24T10:00:00.000Z",
    source: "brain",
    type,
    payload,
  } as Extract<RunEvent, { type: T }>;
}
