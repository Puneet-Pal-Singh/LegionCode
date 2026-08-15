import { describe, expect, it } from "vitest";
import {
  LifecycleEventSchema,
  TurnIdSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import {
  buildSegmentTitle,
  groupToolActivity,
} from "./tool-activity-grouping.js";
import {
  applyLifecycleEvent,
  createTurnWorkflowProjection,
  replayTurnWorkflowProjection,
} from "./turn-workflow-projection.js";

const TURN_ID = TurnIdSchema.parse("trn_workflow01");
const THREAD_ID = "thr_workflow01";
const ATTEMPT_ID = "attempt_workflow01";

describe("turn workflow projection", () => {
  it("preserves typed tool families and repeated ordered children", () => {
    const projection = replayTurnWorkflowProjection(TURN_ID, [
      toolStarted(1, "itm_read01", "toolcall_read01", "read", "Read README.md"),
      toolCompleted(2, "itm_read01", "toolcall_read01"),
      toolStarted(3, "itm_edit01", "toolcall_edit01", "read", "Edit README.md"),
      toolCompleted(4, "itm_edit01", "toolcall_edit01"),
    ]);

    const segments = groupToolActivity(projection.items);
    expect(projection.items.map((item) => item.toolFamily)).toEqual([
      "read",
      "read",
    ]);
    expect(projection.items.map((item) => item.kind)).toEqual([
      "tool_call",
      "tool_call",
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.familyLabels).toEqual(["read"]);
    expect(segments[0]?.children.map((item) => item.itemId)).toEqual([
      "itm_read01",
      "itm_edit01",
    ]);
    expect(segments[0]?.children[0]?.detail).toBe("Read README.md");
    expect(buildSegmentTitle(segments[0]!)).toBe("read files");
  });

  it("does not duplicate a lifecycle item when the exact event is replayed twice", () => {
    const started = toolStarted(
      1,
      "itm_gitcall01",
      "toolcall_gitcall01",
      "git",
      "Git diff",
    );

    const projection = replayTurnWorkflowProjection(TURN_ID, [started, started]);

    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]?.itemId).toBe("itm_gitcall01");
    expect(projection.items[0]?.sequence).toBe(1);
  });

  it("keeps distinct repeated Git tool calls auditable", () => {
    const projection = replayTurnWorkflowProjection(TURN_ID, [
      toolStarted(
        1,
        "itm_gitcall01",
        "toolcall_gitcall01",
        "git",
        "Git diff",
      ),
      toolStarted(
        2,
        "itm_gitcall02",
        "toolcall_gitcall02",
        "git",
        "Git diff",
      ),
    ]);

    const children = groupToolActivity(projection.items).flatMap(
      (segment) => segment.children,
    );

    expect(children.map((item) => item.itemId)).toEqual([
      "itm_gitcall01",
      "itm_gitcall02",
    ]);
  });

  it("does not synthesize item settlement from a terminal event", () => {
    const projection = applyLifecycleEvent(
      applyLifecycleEvent(
        createTurnWorkflowProjection(TURN_ID),
        toolStarted(
          1,
          "itm_read01",
          "toolcall_read01",
          "read",
          "Read README.md",
        ),
      ),
      event(2, "turn.interrupted", {
        payload: {
          outcome: { status: "interrupted", reason: "User stopped the turn." },
        },
      }),
    );

    expect(projection.phase).toBe("interrupted");
    expect(projection.terminal?.state).toBe("interrupted");
    expect(projection.items[0]).toMatchObject({
      itemId: "itm_read01",
      status: "active",
      completedAt: null,
    });
  });

  it("projects the typed failure reason inside the canonical terminal", () => {
    const projection = applyLifecycleEvent(
      createTurnWorkflowProjection(TURN_ID),
      event(1, "turn.failed", {
        payload: {
          outcome: {
            status: "failed",
            failure: {
              code: "provider_unavailable",
              message: "OpenCode Zen route failed",
              retryable: true,
              correlationId: null,
              details: null,
            },
          },
        },
      }),
    );

    expect(projection.terminal).toMatchObject({
      state: "failed",
      content: "OpenCode Zen route failed",
      errorCode: "provider_unavailable",
    });
  });

  it("projects canonical file, diff and shell details for interactive renderers", () => {
    const projection = replayTurnWorkflowProjection(TURN_ID, [
      event(1, "tool_call.started", {
        itemId: "itm_edit01",
        toolCallId: "toolcall_edit01",
        payload: {
          display: {
            family: "edit",
            namespace: "apply_patch",
            title: "Edit file",
            inputSummary: "Edit src/Hero.tsx",
          },
          input: { path: "src/Hero.tsx" },
        },
      }),
      event(2, "tool_call.completed", {
        itemId: "itm_edit01",
        toolCallId: "toolcall_edit01",
        payload: {
          result: {
            content: "Applied patch.",
            metadata: {
              activity: {
                change: "created",
                filePath: "src/Hero.tsx",
                diffPreview: "-old\\n+new",
                additions: 1,
                deletions: 1,
              },
            },
          },
        },
      }),
      event(3, "tool_call.started", {
        itemId: "itm_shell01",
        toolCallId: "toolcall_shell01",
        payload: {
          display: {
            family: "shell",
            namespace: "bash",
            title: "Run command",
            inputSummary: "pnpm test",
          },
          input: { command: "pnpm test" },
        },
      }),
      event(4, "tool_call.completed", {
        itemId: "itm_shell01",
        toolCallId: "toolcall_shell01",
        payload: { result: { content: "2 tests passed" } },
      }),
    ]);

    expect(projection.items[0]).toMatchObject({
      toolName: "apply_patch",
      filePath: "src/Hero.tsx",
      diffPreview: "-old\\n+new",
      additions: 1,
      deletions: 1,
      editChange: "created",
    });
    expect(projection.items[1]).toMatchObject({
      toolName: "bash",
      command: "pnpm test",
      outputContent: "2 tests passed",
    });
  });

  it("coalesces repeated reads of one path and hides legacy multi_edit noise", () => {
    const projection = replayTurnWorkflowProjection(TURN_ID, [
      toolStarted(1, "itm_read01", "toolcall_read01", "read", "src/Footer.tsx"),
      event(2, "tool_call.completed", {
        itemId: "itm_read01",
        toolCallId: "toolcall_read01",
        payload: {
          result: {
            content:
              "[read_file] path=src/Footer.tsx offset=0 limit=200 returnedLines=2 totalLines=2 truncated=false\n1: one\n2: two",
          },
        },
      }),
      toolStarted(3, "itm_read02", "toolcall_read02", "read", "src/Footer.tsx"),
      event(4, "tool_call.completed", {
        itemId: "itm_read02",
        toolCallId: "toolcall_read02",
        payload: {
          result: {
            content:
              "[read_file] path=src/Footer.tsx offset=2 limit=200 returnedLines=0 totalLines=2 truncated=false\n",
          },
        },
      }),
      event(5, "tool_call.started", {
        itemId: "itm_multi01",
        toolCallId: "toolcall_multi01",
        payload: {
          display: {
            family: "edit",
            namespace: "multi_edit",
            title: "Multi Edit",
            inputSummary: "src/Footer.tsx",
          },
        },
      }),
    ]);

    const children = groupToolActivity(projection.items).flatMap(
      (segment) => segment.children,
    );
    expect(children).toHaveLength(1);
    expect(children[0]?.itemId).toBe("itm_read01");
    expect(children[0]?.outputContent).toContain("returnedLines=2");
  });

  it("enriches an edit row from the canonical turn diff when tool metadata has no patch", () => {
    const snapshot = {
      turnId: TURN_ID,
      snapshotKey: TURN_ID,
      treeId: "a".repeat(40),
      headSha: "b".repeat(40),
      phase: "start" as const,
      capturedAt: "2026-07-27T10:00:00.000Z",
    };
    const projection = replayTurnWorkflowProjection(TURN_ID, [
      event(1, "tool_call.started", {
        itemId: "itm_edit01",
        toolCallId: "toolcall_edit01",
        payload: {
          display: {
            family: "edit",
            namespace: "apply_patch",
            title: "Edit file",
            inputSummary: "Edit src/Hero.tsx",
          },
          input: { path: "src/Hero.tsx" },
        },
      }),
      event(2, "tool_call.completed", {
        itemId: "itm_edit01",
        toolCallId: "toolcall_edit01",
        payload: { result: { content: "Applied patch." } },
      }),
      event(3, "turn.diff_updated", {
        payload: {
          diff: {
            turnId: TURN_ID,
            startSnapshot: snapshot,
            terminalSnapshot: {
              ...snapshot,
              phase: "terminal",
              treeId: "c".repeat(40),
            },
            files: [
              {
                path: "src/Hero.tsx",
                status: "modified",
                additions: 1,
                deletions: 1,
                previousPath: null,
              },
            ],
            patch:
              "diff --git a/src/Hero.tsx b/src/Hero.tsx\\n--- a/src/Hero.tsx\\n+++ b/src/Hero.tsx\\n@@ -1 +1 @@\\n-old\\n+new",
          },
        },
      }),
    ]);

    const edit = groupToolActivity(
      projection.items,
      projection.turnDiff,
    ).flatMap((segment) => segment.children)[0];
    expect(edit).toMatchObject({
      filePath: "src/Hero.tsx",
      additions: 1,
      deletions: 1,
    });
    expect(edit?.diffPreview).toContain("-old");
    expect(edit?.diffPreview).toContain("+new");
  });

  it("uses explicit item settlement evidence before the interrupted terminal", () => {
    const projection = replayTurnWorkflowProjection(TURN_ID, [
      toolStarted(1, "itm_read01", "toolcall_read01", "read", "Read README.md"),
      event(2, "tool_call.interrupted", {
        itemId: "itm_read01",
        toolCallId: "toolcall_read01",
        payload: { reason: "User stopped the turn." },
      }),
      event(3, "item.interrupted", {
        itemId: "itm_read01",
        payload: { reason: "User stopped the turn." },
      }),
      event(4, "turn.interrupted", {
        payload: {
          outcome: { status: "interrupted", reason: "User stopped the turn." },
        },
      }),
    ]);

    expect(projection.items[0]).toMatchObject({
      itemId: "itm_read01",
      status: "interrupted",
      completedAt: "2026-07-27T10:00:03.000Z",
    });
  });

  it("keeps context, usage and compaction identical across replay and continuation", () => {
    const events = [
      event(1, "context_budget.updated", {
        payload: {
          snapshot: {
            providerId: "openai",
            modelId: "gpt-5",
            contextWindowLimit: 100,
            systemTokens: 10,
            conversationTokens: 50,
            toolDefinitionTokens: 5,
            attachmentTokens: null,
            repositoryContextTokens: null,
            reservedOutputTokens: 20,
            safetyReserveTokens: 10,
            effectiveInputBudget: 70,
            tokensUsed: 65,
            tokensRemaining: 5,
            utilizationPercent: 92.85,
            warningThresholdPercent: 70,
            automaticCompactionThresholdPercent: 80,
            measurementSource: "tokenizer",
          },
        },
      }),
      event(2, "usage.updated", {
        payload: {
          usage: {
            providerId: "openai",
            modelId: "gpt-5",
            inputTokens: 65,
            outputTokens: 8,
            cachedInputTokens: 10,
            reasoningTokens: 2,
            totalTokens: 73,
            currentTurnCost: 0.02,
            cumulativeThreadTokens: 73,
            cumulativeThreadCost: 0.02,
            currency: "USD",
            measurementSource: "provider",
          },
        },
      }),
      event(3, "context_compaction.requested", {
        itemId: "itm_context01",
        payload: {
          compactionId: "cmp_context01",
          itemId: "itm_context01",
          mode: "manual",
          phase: "requested",
          preservedContextReference: null,
          summary: null,
          error: null,
        },
      }),
      event(4, "context_compaction.completed", {
        itemId: "itm_context01",
        payload: {
          compactionId: "cmp_context01",
          itemId: "itm_context01",
          mode: "manual",
          phase: "compacted",
          preservedContextReference: "context:trn_workflow01:compacted",
          summary: "Preserved request.",
          error: null,
        },
      }),
    ];
    const full = replayTurnWorkflowProjection(TURN_ID, events);
    const incremental = events.reduce(
      applyLifecycleEvent,
      createTurnWorkflowProjection(TURN_ID),
    );
    expect(incremental).toEqual(full);
    expect(full.contextBudget?.tokensUsed).toBe(65);
    expect(full.usage?.cumulativeThreadTokens).toBe(73);
    expect(full.items.at(-1)).toMatchObject({
      kind: "context_compaction",
      compactionPhase: "compacted",
      status: "completed",
    });
    const compactionSegment = groupToolActivity(full.items).at(-1);
    expect(buildSegmentTitle(compactionSegment!)).toBe("compacted context");
  });
});

function toolStarted(
  sequence: number,
  itemId: string,
  toolCallId: string,
  family:
    | "read"
    | "search"
    | "shell"
    | "edit"
    | "git"
    | "web"
    | "image"
    | "skill"
    | "browser"
    | "mcp"
    | "dynamic"
    | "generic",
  detail: string,
): LifecycleEvent {
  return event(sequence, "tool_call.started", {
    itemId,
    toolCallId,
    payload: {
      display: {
        family,
        namespace: "filesystem",
        title: "Read File",
        inputSummary: detail,
      },
    },
  });
}

function toolCompleted(
  sequence: number,
  itemId: string,
  toolCallId: string,
): LifecycleEvent {
  return event(sequence, "tool_call.completed", {
    itemId,
    toolCallId,
    payload: { result: { ok: true } },
  });
}

function event(
  sequence: number,
  type: LifecycleEvent["type"],
  fields: Record<string, unknown>,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_workflow${sequence}`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    runAttemptId: ATTEMPT_ID,
    sequence,
    idempotencyKey: `${TURN_ID}:${sequence}:${type}`,
    producer: { kind: "runtime_kernel", id: "workflow-test" },
    schemaVersion: 1,
    createdAt: `2026-07-27T10:00:0${sequence}.000Z`,
    type,
    ...fields,
  });
}
