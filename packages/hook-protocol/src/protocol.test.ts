import { describe, expect, it } from "vitest";
import {
  HookInvocationAuditEventSchema,
  HookEventNameSchema,
  PermissionRequestOutcomeSchema,
  UserPromptSubmitRequestSchema,
} from "./index.js";
import { createTestContext } from "./testSupport.js";

const timestamp = "2026-06-09T12:00:00.000Z";

describe("hook protocol schemas", () => {
  it("keeps the Codex-compatible lifecycle event names available", () => {
    expect(HookEventNameSchema.options).toEqual([
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]);
  });

  it("rejects invalid hook requests at the protocol boundary", () => {
    expect(() =>
      UserPromptSubmitRequestSchema.parse({
        context: createTestContext(),
        prompt: "",
        attachments: [],
        selectedFiles: [],
        selectedMode: "auto_edit",
      }),
    ).toThrow();
  });

  it("keeps permission-request outcomes constrained to approval states", () => {
    expect(
      PermissionRequestOutcomeSchema.parse({
        status: "approve",
        userVisibleMessage: null,
        modelContextAdditions: [],
        auditMetadata: {},
        decisionReason: "Trusted policy approved this action.",
      }).status,
    ).toBe("approve");

    expect(() =>
      PermissionRequestOutcomeSchema.parse({
        status: "continue",
        userVisibleMessage: null,
        modelContextAdditions: [],
        auditMetadata: {},
        decisionReason: null,
      }),
    ).toThrow();
  });

  it("requires durable invocation audit data", () => {
    const invocation = {
      invocationId: "hki_abcdef",
      eventId: "evt_abcdef",
      runId: "run_abcdef",
      sessionId: "thr_abcdef",
      threadId: "thr_abcdef",
      handlerId: "system.session_context",
      eventName: "SessionStart",
      startedAt: timestamp,
      completedAt: timestamp,
      status: "completed",
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
      errorCode: null,
      errorMessage: null,
    };

    const auditEvent = HookInvocationAuditEventSchema.parse({
      auditEventId: "evt_audit1",
      eventType: "hook.invocation.completed",
      invocation,
      outcome: {
        status: "continue",
        userVisibleMessage: null,
        modelContextAdditions: [],
        auditMetadata: {},
      },
      metadata: {},
      emittedAt: timestamp,
      eventSequence: 1,
    });

    expect(auditEvent.invocation.inputHash).toBe("a".repeat(64));
    expect(() =>
      HookInvocationAuditEventSchema.parse({
        ...auditEvent,
        invocation: { ...invocation, inputHash: "not-a-hash" },
      }),
    ).toThrow();
  });
});
