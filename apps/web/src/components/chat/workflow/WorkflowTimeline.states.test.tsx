import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  applyLifecycleEvent,
  createTurnWorkflowProjection,
  LifecycleEventSchema,
  replayTurnWorkflowProjection,
  TurnIdSchema,
  type LifecycleEvent,
} from "@repo/platform-client-sdk";
import { CanonicalWorkflowSurface } from "./CanonicalWorkflowSurface.js";

const turnId = TurnIdSchema.parse("trn_status01");

describe("workflow parent states and request history", () => {
  it("keeps its parent mounted from Thinking through tool, approval and resumed work", () => {
    let projection = createTurnWorkflowProjection(turnId);
    const { rerender } = render(
      <CanonicalWorkflowSurface projection={projection} />,
    );
    const title = screen.getByTestId("active-workflow-title");
    expect(title).toHaveTextContent(/^Thinking$/);
    const tool = event(1, "tool_call.started", {
      itemId: "itm_status_tool",
      toolCallId: "toolcall_status01",
      payload: {
        display: {
          title: "Run command",
          family: "shell",
          namespace: "bash",
          inputSummary: "git status",
        },
      },
    });
    projection = applyLifecycleEvent(projection, tool);
    rerender(<CanonicalWorkflowSurface projection={projection} />);
    expect(screen.getByTestId("active-workflow-title")).toBe(title);
    expect(title).toHaveTextContent("Running git status");

    projection = applyLifecycleEvent(
      projection,
      event(2, "approval.requested", {
        itemId: "itm_status_approval",
        approvalId: "appr_status01",
        payload: {
          question: "Allow access to Docker?",
          options: ["Approve", "Deny"],
        },
      }),
    );
    rerender(<CanonicalWorkflowSurface projection={projection} />);
    expect(screen.getByTestId("active-workflow-title")).toBe(title);
    expect(title).toHaveTextContent("Awaiting approval");
    expect(title).not.toHaveClass("turn-lifecycle-shimmer");

    projection = applyLifecycleEvent(
      projection,
      event(3, "approval.decided", {
        itemId: "itm_status_approval",
        approvalId: "appr_status01",
        payload: { status: "approved" },
      }),
    );
    rerender(<CanonicalWorkflowSurface projection={projection} />);
    expect(title).toHaveTextContent("Running git status");
    fireEvent.click(
      screen.getByRole("button", {
        name: "View details for Requested permission",
      }),
    );
    expect(screen.getByText("Allow access to Docker?")).toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();

    projection = applyLifecycleEvent(
      projection,
      event(4, "tool_call.completed", {
        itemId: "itm_status_tool",
        toolCallId: "toolcall_status01",
        payload: { result: {} },
      }),
    );
    rerender(<CanonicalWorkflowSurface projection={projection} />);
    expect(title).toHaveTextContent(/^Thinking$/);
  });

  it("replays question and answer history, including after a completed turn", () => {
    const requested = event(1, "user_input.requested", {
      itemId: "itm_status_input",
      requestId: "request_status01",
      payload: {
        questions: [
          { id: "q1", question: "Which database should I use?" },
          { id: "q2", question: "Run migrations?" },
        ],
      },
    });
    const projection = replayTurnWorkflowProjection(turnId, [requested]);
    const { rerender } = render(
      <CanonicalWorkflowSurface projection={projection} />,
    );
    expect(screen.getByTestId("active-workflow-title")).toHaveTextContent(
      "Waiting for your answer",
    );
    const answered = event(2, "user_input.responded", {
      itemId: "itm_status_input",
      requestId: "request_status01",
      payload: {
        response: {
          answers: { q1: { answers: ["Postgres"] }, q2: { answers: ["Yes"] } },
        },
      },
    });
    const terminal = event(3, "turn.completed", {
      payload: { outcome: { status: "completed" } },
    });
    rerender(
      <CanonicalWorkflowSurface
        projection={replayTurnWorkflowProjection(turnId, [
          requested,
          answered,
          terminal,
        ])}
      />,
    );
    expect(
      screen.queryByTestId("active-workflow-title"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /worked for/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "View details for Asked questions" }),
    );
    expect(
      screen.getByText("Which database should I use?"),
    ).toBeInTheDocument();
    expect(screen.getByText("Postgres")).toBeInTheDocument();
    expect(screen.getByText("Run migrations?")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("updates provider summary labels without replacing full commentary or reasoning", () => {
    const started = event(1, "item.started", {
      itemId: "itm_status_reasoning",
      payload: { kind: "reasoning" },
    });
    const first = event(2, "reasoning.summary_delta", {
      itemId: "itm_status_reasoning",
      payload: {
        delta: "**Inspecting database migrations**",
        displaySafe: true,
      },
    });
    const second = event(3, "reasoning.summary_delta", {
      itemId: "itm_status_reasoning",
      payload: {
        delta: "\n\n**Correlating the requested steps**",
        displaySafe: true,
      },
    });
    const { rerender } = render(
      <CanonicalWorkflowSurface
        projection={replayTurnWorkflowProjection(turnId, [started, first])}
      />,
    );
    const title = screen.getByTestId("active-workflow-title");
    expect(title).toHaveTextContent("Inspecting database migrations");
    rerender(
      <CanonicalWorkflowSurface
        projection={replayTurnWorkflowProjection(turnId, [
          started,
          first,
          second,
        ])}
      />,
    );
    expect(screen.getByTestId("active-workflow-title")).toBe(title);
    expect(title).toHaveTextContent("Correlating the requested steps");
    expect(screen.getAllByText("Inspecting database migrations")).toHaveLength(
      1,
    );
  });
});

function event(
  sequence: number,
  type: LifecycleEvent["type"],
  fields: Record<string, unknown>,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_status${sequence}`,
    threadId: "thr_status01",
    turnId,
    runAttemptId: "attempt_status01",
    sequence,
    idempotencyKey: `status:${sequence}`,
    producer: { kind: "runtime_kernel", id: "workflow-status-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, sequence)).toISOString(),
    type,
    ...fields,
  });
}
