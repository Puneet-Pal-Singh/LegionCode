import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  HookInvocationAuditEventSchema,
  type HookInvocationAuditEvent,
} from "../../../services/api/lifecycleClient";
import { MessageActions } from "./MessageActions";

describe("MessageActions", () => {
  it("shows runtime-owned hook audits on an assistant message", () => {
    render(
      <MessageActions
        content="Done"
        isUser={false}
        hookAudits={[hookAudit()]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View hook activity" }));
    expect(screen.getByText("User Prompt Submit")).toBeVisible();
    expect(screen.getByText("project · completed")).toBeVisible();
  });
});

function hookAudit(): HookInvocationAuditEvent {
  return HookInvocationAuditEventSchema.parse({
    auditEventId: "evt_hook001",
    eventSequence: 1,
    eventType: "hook.invocation.completed",
    emittedAt: "2026-08-10T00:00:00.000Z",
    invocation: {
      invocationId: "hki_hook001",
      eventId: "evt_trigger001",
      runId: "run_hook001",
      threadId: "thr_hook001",
      handlerId: "project.audit",
      source: "project",
      order: 0,
      eventName: "UserPromptSubmit",
      startedAt: "2026-08-10T00:00:00.000Z",
      completedAt: "2026-08-10T00:00:00.010Z",
      status: "completed",
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
      errorCode: null,
      errorMessage: null,
    },
    outcomeSummary: {
      eventName: "UserPromptSubmit",
      status: "continue",
      cleanupStatus: null,
      addedContextCount: 0,
      hasUserVisibleMessage: false,
    },
    metadata: {
      durationMs: 10,
      cleanupStatus: null,
    },
  });
}
