import { HookInvocationAuditEventSchema } from "@repo/platform-client-sdk";
import { describe, expect, it } from "vitest";
import { buildHookAuditDisclosureViewModel } from "./HookAuditViewModel.js";

const HASH = "a".repeat(64);

function createAuditEvent(
  overrides: Record<string, unknown> = {},
) {
  return HookInvocationAuditEventSchema.parse({
    auditEventId: "evt_hookaudit_001",
    eventType: "hook.invocation.completed",
    invocation: {
      invocationId: "hki_hookaudit_001",
      eventId: "evt_hookevent_001",
      runId: "run_hookaudit_001",
      threadId: "thr_hookaudit_001",
      handlerId: "project-lint-hook",
      source: "project",
      order: 1,
      eventName: "UserPromptSubmit",
      startedAt: "2026-07-18T10:00:00.000Z",
      completedAt: "2026-07-18T10:00:02.500Z",
      status: "completed",
      inputHash: HASH,
      outputHash: HASH,
      errorCode: null,
      errorMessage: null,
    },
    outcomeSummary: {
      eventName: "UserPromptSubmit",
      status: "continue",
      addedContextCount: 0,
      hasUserVisibleMessage: false,
      cleanupStatus: null,
    },
    metadata: { durationMs: 2_500, cleanupStatus: null },
    emittedAt: "2026-07-18T10:00:02.500Z",
    eventSequence: 1,
    ...overrides,
  });
}

describe("buildHookAuditDisclosureViewModel", () => {
  it("maps a completed canonical audit event without exposing hashes", () => {
    const model = buildHookAuditDisclosureViewModel(createAuditEvent());

    expect(model).toMatchObject({
      label: "Ran User Prompt Submit hook",
      statusLabel: "Completed",
      sourceLabel: "Project",
      durationLabel: "2s",
      outcomeLabel: "Outcome: continue",
      failure: null,
    });
    expect(JSON.stringify(model)).not.toContain(HASH);
  });

  it("uses a subtle typed hook failure label", () => {
    const model = buildHookAuditDisclosureViewModel(
      createAuditEvent({
        eventType: "hook.invocation.failed",
        invocation: {
          invocationId: "hki_hookaudit_001",
          eventId: "evt_hookevent_001",
          runId: "run_hookaudit_001",
          threadId: "thr_hookaudit_001",
          handlerId: "project-lint-hook",
          source: "project",
          order: 1,
          eventName: "UserPromptSubmit",
          startedAt: "2026-07-18T10:00:00.000Z",
          completedAt: "2026-07-18T10:00:02.500Z",
          status: "failed",
          inputHash: HASH,
          outputHash: null,
          errorCode: "HOOK_TIMEOUT",
          errorMessage: "The project hook did not respond in time.",
        },
        outcomeSummary: null,
        metadata: { durationMs: 2_500, cleanupStatus: null },
      }),
    );

    expect(model).toMatchObject({
      label: "User Prompt Submit hook failed",
      statusLabel: "Failed",
      failure: {
        code: "HOOK_TIMEOUT",
        message: "The project hook did not respond in time.",
      },
    });
  });
});
