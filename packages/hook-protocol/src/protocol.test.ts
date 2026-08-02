import { describe, expect, it } from "vitest";
import {
  HookInvocationAuditEventSchema,
  HookDefinitionSchema,
  HookEventNameSchema,
  PermissionRequestOutcomeSchema,
  StopOutcomeSchema,
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

  it("limits executable definitions to the four production lifecycle hooks", () => {
    expect(
      HookDefinitionSchema.parse({
        handlerId: "project.prompt_policy",
        eventName: "UserPromptSubmit",
        source: "project",
        displayName: "Prompt policy",
        enabled: true,
        order: 10,
        timeoutMs: 1_000,
        configurationKey: "project:hooks/prompt-policy",
      }).eventName,
    ).toBe("UserPromptSubmit");

    expect(() =>
      HookDefinitionSchema.parse({
        handlerId: "project.pre_tool",
        eventName: "PreToolUse",
        source: "project",
        displayName: "Pre-tool hook",
        enabled: true,
        order: 10,
        timeoutMs: 1_000,
        configurationKey: null,
      }),
    ).toThrow();
  });

  it("does not allow stop hooks to mutate final assistant text", () => {
    expect(() =>
      StopOutcomeSchema.parse({
        status: "continue",
        finalMessagePatch: "Replace the model final.",
        cleanupResult: null,
        userVisibleMessage: null,
        modelContextAdditions: [],
        auditMetadata: {},
      }),
    ).toThrow();
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
      threadId: "thr_abcdef",
      handlerId: "system.session_context",
      source: "project",
      order: 10,
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
      outcomeSummary: {
        eventName: "SessionStart",
        status: "continue",
        hasUserVisibleMessage: false,
        addedContextCount: 0,
        cleanupStatus: null,
      },
      metadata: { durationMs: 1, cleanupStatus: null },
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
