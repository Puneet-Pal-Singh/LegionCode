import { HookInvocationAuditEventSchema } from "@repo/hook-protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HookAuditDisclosure } from "./HookAuditDisclosure.js";

const HASH = "b".repeat(64);

const failedAuditEvent = HookInvocationAuditEventSchema.parse({
  auditEventId: "evt_hookaudit_002",
  eventType: "hook.invocation.failed",
  invocation: {
    invocationId: "hki_hookaudit_002",
    eventId: "evt_hookevent_002",
    runId: "run_hookaudit_002",
    threadId: "thr_hookaudit_002",
    handlerId: "user-preflight-hook",
    source: "user",
    order: 0,
    eventName: "SessionStart",
    startedAt: "2026-07-18T10:00:00.000Z",
    completedAt: "2026-07-18T10:00:00.350Z",
    status: "failed",
    inputHash: HASH,
    outputHash: null,
    errorCode: "HOOK_NETWORK_ERROR",
    errorMessage: "The hook could not reach its configured service.",
  },
  outcomeSummary: null,
  metadata: { durationMs: 350, cleanupStatus: null },
  emittedAt: "2026-07-18T10:00:00.350Z",
  eventSequence: 2,
});

describe("HookAuditDisclosure", () => {
  it("keeps hook details compact until explicitly expanded", () => {
    const onToggle = vi.fn();
    render(
      <HookAuditDisclosure
        event={failedAuditEvent}
        expanded={false}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByText("Session Start hook failed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("HOOK_NETWORK_ERROR")).not.toBeInTheDocument();
    expect(screen.queryByText(HASH)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Session Start hook failed/i }),
    );
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("renders only the safe typed failure fields when expanded", () => {
    render(
      <HookAuditDisclosure
        event={failedAuditEvent}
        expanded={true}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Session Start")).toBeInTheDocument();
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("user-preflight-hook")).toBeInTheDocument();
    expect(screen.getByText("350ms")).toBeInTheDocument();
    expect(
      screen.getByText("The hook could not reach its configured service."),
    ).toBeInTheDocument();
    expect(screen.queryByText(HASH)).not.toBeInTheDocument();
  });
});
