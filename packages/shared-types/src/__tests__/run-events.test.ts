/**
 * Run Events Tests - Validate event types, schemas, and compatibility layer
 */

import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_TYPES,
  RUN_WORKFLOW_STEPS,
  isTurnActivityTranscriptPart,
  isRunEvent,
  isRunEventOfType,
  type RunEvent,
  type RunStartedEvent,
} from "../run-events.js";
import {
  parseRunEvent,
  safeParseRunEvent,
  validateEventEnvelope,
} from "../run-events.zod.js";
import {
  convertLegacyEvent,
  getCanonicalEventType,
  isLegacyEventName,
  normalizeEvent,
  LEGACY_EVENT_NAMES,
} from "../run-events.compat.js";
import { isRunStatus, RUN_STATUSES } from "../run-status.js";

// ============================================================================
// Run Status Tests
// ============================================================================

describe("RunStatus", () => {
  it("should validate all canonical statuses", () => {
    expect(isRunStatus(RUN_STATUSES.QUEUED)).toBe(true);
    expect(isRunStatus(RUN_STATUSES.RUNNING)).toBe(true);
    expect(isRunStatus(RUN_STATUSES.WAITING)).toBe(true);
    expect(isRunStatus(RUN_STATUSES.PAUSED)).toBe(true);
    expect(isRunStatus(RUN_STATUSES.FAILED)).toBe(true);
    expect(isRunStatus(RUN_STATUSES.COMPLETE)).toBe(true);
  });

  it("should reject invalid status values", () => {
    expect(isRunStatus("invalid")).toBe(false);
    expect(isRunStatus(123)).toBe(false);
    expect(isRunStatus(null)).toBe(false);
  });
});

// ============================================================================
// Run Event Type Tests
// ============================================================================

describe("RunEvent Type Guards", () => {
  const validRunStartedEvent: RunStartedEvent = {
    version: 1,
    eventId: "evt-123",
    runId: "run-456",
    timestamp: new Date().toISOString(),
    source: "brain",
    type: RUN_EVENT_TYPES.RUN_STARTED,
    payload: {
      status: "running",
    },
  };

  it("should validate a canonical run event", () => {
    expect(isRunEvent(validRunStartedEvent)).toBe(true);
  });

  it("should reject non-event objects", () => {
    expect(isRunEvent(null)).toBe(false);
    expect(isRunEvent(undefined)).toBe(false);
    expect(isRunEvent("string")).toBe(false);
    expect(isRunEvent({ foo: "bar" })).toBe(false);
  });

  it("should distinguish between event types", () => {
    expect(
      isRunEventOfType(validRunStartedEvent, RUN_EVENT_TYPES.RUN_STARTED),
    ).toBe(true);
    expect(
      isRunEventOfType(validRunStartedEvent, RUN_EVENT_TYPES.MESSAGE_EMITTED),
    ).toBe(false);
  });
});

describe("Turn activity transcript part guard", () => {
  it("accepts canonical turn activity transcript parts", () => {
    expect(
      isTurnActivityTranscriptPart({
        version: 1,
        type: "turn_activity",
        events: [],
        activitySnapshot: {
          runId: "run-1",
          sessionId: "session-1",
          status: "COMPLETED",
          items: [],
        },
        compacted: false,
      }),
    ).toBe(true);
  });

  it("rejects legacy event-only turn activity transcript parts", () => {
    expect(
      isTurnActivityTranscriptPart({
        version: 1,
        type: "turn_activity",
        events: [],
        compacted: false,
      }),
    ).toBe(false);
  });

  it("rejects non-transcript parts", () => {
    expect(isTurnActivityTranscriptPart({ type: "text", text: "hello" })).toBe(
      false,
    );
    expect(isTurnActivityTranscriptPart(null)).toBe(false);
  });
});

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe("RunEvent Schema Validation", () => {
  it("should parse valid run.started event", () => {
    const event = {
      version: 1,
      eventId: "evt-123",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain" as const,
      type: RUN_EVENT_TYPES.RUN_STARTED,
      payload: {
        status: "running" as const,
      },
    };

    const parsed = parseRunEvent(event);
    expect(parsed.type).toBe(RUN_EVENT_TYPES.RUN_STARTED);
    if (parsed.type === RUN_EVENT_TYPES.RUN_STARTED) {
      expect(parsed.payload.status).toBe("running");
    }
  });

  it("should parse valid tool.requested event", () => {
    const event = {
      version: 1,
      eventId: "evt-789",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain" as const,
      type: RUN_EVENT_TYPES.TOOL_REQUESTED,
      payload: {
        toolId: "tool-123",
        toolName: "read_file",
        arguments: { path: "/etc/passwd" },
        description: "Read /etc/passwd",
        displayText: "Reading /etc/passwd",
      },
    };

    const parsed = parseRunEvent(event);
    expect(parsed.type).toBe(RUN_EVENT_TYPES.TOOL_REQUESTED);
    if (parsed.type === RUN_EVENT_TYPES.TOOL_REQUESTED) {
      expect(parsed.payload.toolName).toBe("read_file");
      expect(parsed.payload.description).toBe("Read /etc/passwd");
      expect(parsed.payload.displayText).toBe("Reading /etc/passwd");
    }
  });

  it("should parse debug run progress metadata", () => {
    const event = {
      version: 1,
      eventId: "evt-progress",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain" as const,
      type: RUN_EVENT_TYPES.RUN_PROGRESS,
      payload: {
        phase: RUN_WORKFLOW_STEPS.EXECUTION,
        label: "Retrying model request",
        summary: "Retrying once before pausing the run.",
        status: "completed" as const,
        displayMode: "debug" as const,
        metadata: {
          code: "MODEL_UNUSABLE_RESPONSE",
          retryCount: 1,
        },
      },
    };

    const parsed = parseRunEvent(event);
    expect(parsed.type).toBe(RUN_EVENT_TYPES.RUN_PROGRESS);
    if (parsed.type === RUN_EVENT_TYPES.RUN_PROGRESS) {
      expect(parsed.payload.displayMode).toBe("debug");
      expect(parsed.payload.metadata?.retryCount).toBe(1);
    }
  });

  it("should trim tool.requested description and displayText", () => {
    const event = {
      version: 1,
      eventId: "evt-790",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain" as const,
      type: RUN_EVENT_TYPES.TOOL_REQUESTED,
      payload: {
        toolId: "tool-123",
        toolName: "read_file",
        arguments: { path: "/etc/passwd" },
        description: "  Read /etc/passwd  ",
        displayText: "  Reading /etc/passwd  ",
      },
    };

    const parsed = parseRunEvent(event);
    expect(parsed.type).toBe(RUN_EVENT_TYPES.TOOL_REQUESTED);
    if (parsed.type === RUN_EVENT_TYPES.TOOL_REQUESTED) {
      expect(parsed.payload.description).toBe("Read /etc/passwd");
      expect(parsed.payload.displayText).toBe("Reading /etc/passwd");
    }
  });

  it("should reject whitespace-only tool.requested copy", () => {
    const event = {
      version: 1,
      eventId: "evt-791",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain" as const,
      type: RUN_EVENT_TYPES.TOOL_REQUESTED,
      payload: {
        toolId: "tool-123",
        toolName: "read_file",
        arguments: { path: "/etc/passwd" },
        description: "   ",
      },
    };

    expect(() => parseRunEvent(event)).toThrow();
  });

  it("should parse valid tool.output.appended event", () => {
    const event = {
      version: 1,
      eventId: "evt-shell-1",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain" as const,
      type: RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED,
      payload: {
        toolId: "tool-123",
        toolName: "bash",
        stdoutDelta: "hello\n",
      },
    };

    const parsed = parseRunEvent(event);
    expect(parsed.type).toBe(RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED);
    if (parsed.type === RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED) {
      expect(parsed.payload.toolName).toBe("bash");
      expect(parsed.payload.stdoutDelta).toBe("hello\n");
    }
  });

  it("should parse run.status.changed events with workflow stage context", () => {
    const event = {
      version: 1,
      eventId: "evt-456",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain" as const,
      type: RUN_EVENT_TYPES.RUN_STATUS_CHANGED,
      payload: {
        previousStatus: "queued" as const,
        newStatus: "running" as const,
        workflowStep: RUN_WORKFLOW_STEPS.EXECUTION,
      },
    };

    const parsed = parseRunEvent(event);
    expect(parsed.type).toBe(RUN_EVENT_TYPES.RUN_STATUS_CHANGED);
    if (parsed.type === RUN_EVENT_TYPES.RUN_STATUS_CHANGED) {
      expect(parsed.payload.workflowStep).toBe(RUN_WORKFLOW_STEPS.EXECUTION);
    }
  });

  it("should reject malformed event (missing required fields)", () => {
    const event = {
      version: 1,
      eventId: "evt-123",
      // missing runId
      timestamp: new Date().toISOString(),
      source: "brain",
      type: RUN_EVENT_TYPES.RUN_STARTED,
      payload: { status: "running" },
    };

    const result = safeParseRunEvent(event);
    expect(result.success).toBe(false);
  });

  it("should reject event with invalid timestamp", () => {
    const event = {
      version: 1,
      eventId: "evt-123",
      runId: "run-456",
      timestamp: "not-a-date",
      source: "brain",
      type: RUN_EVENT_TYPES.RUN_STARTED,
      payload: { status: "running" },
    };

    const result = safeParseRunEvent(event);
    expect(result.success).toBe(false);
  });

  it("should reject event with invalid payload for type", () => {
    const event = {
      version: 1,
      eventId: "evt-123",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain",
      type: RUN_EVENT_TYPES.TOOL_REQUESTED,
      payload: {
        // missing toolId, toolName, arguments
      },
    };

    const result = safeParseRunEvent(event);
    expect(result.success).toBe(false);
  });

  it("should validate event envelope structure", () => {
    const envelope = {
      version: 1,
      eventId: "evt-123",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain",
      type: RUN_EVENT_TYPES.RUN_STARTED,
      payload: { status: "running" },
    };

    const result = validateEventEnvelope(envelope);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Compatibility Layer Tests
// ============================================================================

describe("Legacy Event Compatibility", () => {
  it("should identify legacy event names", () => {
    expect(isLegacyEventName(LEGACY_EVENT_NAMES.EXECUTION_STARTED)).toBe(true);
    expect(isLegacyEventName(LEGACY_EVENT_NAMES.TOOL_CALLED)).toBe(true);
    expect(isLegacyEventName("run.started")).toBe(false);
  });

  it("should map legacy event names to canonical types", () => {
    expect(getCanonicalEventType(LEGACY_EVENT_NAMES.EXECUTION_STARTED)).toBe(
      RUN_EVENT_TYPES.RUN_STARTED,
    );
    expect(getCanonicalEventType(LEGACY_EVENT_NAMES.TOOL_CALLED)).toBe(
      RUN_EVENT_TYPES.TOOL_REQUESTED,
    );
    expect(getCanonicalEventType("invalid")).toBeNull();
  });

  it("should convert legacy execution_started event", () => {
    const legacyEvent = {
      type: LEGACY_EVENT_NAMES.EXECUTION_STARTED,
      runId: "run-123",
      executionId: "exec-456",
      timestamp: new Date().toISOString(),
      payload: {
        status: "running",
      },
    };

    const converted = convertLegacyEvent(legacyEvent);
    expect(converted).not.toBeNull();
    expect(converted!.type).toBe(RUN_EVENT_TYPES.RUN_STARTED);
    expect(converted!.runId).toBe("run-123");
  });

  it("should convert legacy tool_called event", () => {
    const legacyEvent = {
      type: LEGACY_EVENT_NAMES.TOOL_CALLED,
      runId: "run-123",
      timestamp: new Date().toISOString(),
      payload: {
        toolId: "tool-123",
        name: "read_file",
        args: { path: "/tmp/test.txt" },
      },
    };

    const converted = convertLegacyEvent(legacyEvent);
    expect(converted).not.toBeNull();
    expect(converted!.type).toBe(RUN_EVENT_TYPES.TOOL_REQUESTED);
    if (converted!.type === RUN_EVENT_TYPES.TOOL_REQUESTED) {
      const payload = converted!.payload;
      expect(payload.toolName).toBe("read_file");
      expect(payload.arguments).toEqual({ path: "/tmp/test.txt" });
      expect(payload.description).toBeUndefined();
      expect(payload.displayText).toBeUndefined();
    }
  });

  it("should convert legacy execution_completed event", () => {
    const legacyEvent = {
      type: LEGACY_EVENT_NAMES.EXECUTION_COMPLETED,
      runId: "run-123",
      timestamp: new Date().toISOString(),
      payload: {
        durationMs: 5000,
        toolsUsed: 3,
      },
    };

    const converted = convertLegacyEvent(legacyEvent);
    expect(converted).not.toBeNull();
    expect(converted!.type).toBe(RUN_EVENT_TYPES.RUN_COMPLETED);
    if (converted!.type === RUN_EVENT_TYPES.RUN_COMPLETED) {
      const payload = converted!.payload;
      expect(payload.totalDurationMs).toBe(5000);
      expect(payload.toolsUsed).toBe(3);
    }
  });

  it("should preserve zero values in numeric fields (nullish coalescing)", () => {
    const legacyEvent = {
      type: LEGACY_EVENT_NAMES.EXECUTION_COMPLETED,
      runId: "run-zero",
      timestamp: new Date().toISOString(),
      payload: {
        durationMs: 0, // Explicitly 0
        toolsUsed: 0, // No tools used
      },
    };

    const converted = convertLegacyEvent(legacyEvent);
    expect(converted).not.toBeNull();
    expect(converted!.type).toBe(RUN_EVENT_TYPES.RUN_COMPLETED);
    if (converted!.type === RUN_EVENT_TYPES.RUN_COMPLETED) {
      const payload = converted!.payload;
      // Zero should be preserved, not replaced with fallback
      expect(payload.totalDurationMs).toBe(0);
      expect(payload.toolsUsed).toBe(0);
    }
  });

  it("should preserve falsy-but-valid result values in tool completion (nullish coalescing)", () => {
    // Test with result = 0 (falsy but valid)
    const legacyEventZero = {
      type: LEGACY_EVENT_NAMES.TOOL_COMPLETED_LEGACY,
      runId: "run-result-zero",
      timestamp: new Date().toISOString(),
      payload: {
        toolId: "tool-123",
        name: "calculator",
        result: 0, // Falsy but valid numeric result
        durationMs: 100,
      },
    };

    const convertedZero = convertLegacyEvent(legacyEventZero);
    expect(convertedZero).not.toBeNull();
    if (convertedZero?.type === RUN_EVENT_TYPES.TOOL_COMPLETED) {
      expect(convertedZero.payload.result).toBe(0);
    }

    // Test with result = false (falsy but valid)
    const legacyEventFalse = {
      type: LEGACY_EVENT_NAMES.TOOL_COMPLETED_LEGACY,
      runId: "run-result-false",
      timestamp: new Date().toISOString(),
      payload: {
        toolId: "tool-456",
        name: "validator",
        result: false, // Falsy but valid boolean result
        durationMs: 50,
      },
    };

    const convertedFalse = convertLegacyEvent(legacyEventFalse);
    expect(convertedFalse).not.toBeNull();
    if (convertedFalse?.type === RUN_EVENT_TYPES.TOOL_COMPLETED) {
      expect(convertedFalse.payload.result).toBe(false);
    }

    // Test with result = "" (falsy but valid)
    const legacyEventEmpty = {
      type: LEGACY_EVENT_NAMES.TOOL_COMPLETED_LEGACY,
      runId: "run-result-empty",
      timestamp: new Date().toISOString(),
      payload: {
        toolId: "tool-789",
        name: "processor",
        result: "", // Falsy but valid empty string result
        durationMs: 75,
      },
    };

    const convertedEmpty = convertLegacyEvent(legacyEventEmpty);
    expect(convertedEmpty).not.toBeNull();
    if (convertedEmpty?.type === RUN_EVENT_TYPES.TOOL_COMPLETED) {
      expect(convertedEmpty.payload.result).toBe("");
    }
  });

  it("should normalize canonical events without conversion", () => {
    const canonicalEvent: RunEvent = {
      version: 1,
      eventId: "evt-123",
      runId: "run-456",
      timestamp: new Date().toISOString(),
      source: "brain",
      type: RUN_EVENT_TYPES.RUN_STARTED,
      payload: {
        status: "running",
      },
    };

    const normalized = normalizeEvent(canonicalEvent);
    expect(normalized).not.toBeNull();
    expect(normalized!.type).toBe(RUN_EVENT_TYPES.RUN_STARTED);
  });

  it("should return null for unrecognized events", () => {
    const unknownEvent = {
      eventId: "evt-123",
      // missing required fields
    };

    const normalized = normalizeEvent(unknownEvent);
    expect(normalized).toBeNull();
  });
});

// ============================================================================
// Full Event Lifecycle Tests
// ============================================================================

describe("Run Event Lifecycle", () => {
  it("should create a complete run event sequence", () => {
    const timestamp = new Date().toISOString();
    const runId = "run-123";

    // 1. Start
    const startEvent = parseRunEvent({
      version: 1,
      eventId: "evt-1",
      runId,
      timestamp,
      source: "brain" as const,
      type: RUN_EVENT_TYPES.RUN_STARTED,
      payload: { status: "running" as const },
    });
    expect(startEvent.type).toBe(RUN_EVENT_TYPES.RUN_STARTED);

    // 2. Tool request
    const toolEvent = parseRunEvent({
      version: 1,
      eventId: "evt-2",
      runId,
      timestamp,
      source: "brain" as const,
      type: RUN_EVENT_TYPES.TOOL_REQUESTED,
      payload: {
        toolId: "tool-1",
        toolName: "search",
        arguments: { query: "test" },
      },
    });
    expect(toolEvent.type).toBe(RUN_EVENT_TYPES.TOOL_REQUESTED);

    // 3. Tool complete
    const completeEvent = parseRunEvent({
      version: 1,
      eventId: "evt-3",
      runId,
      timestamp,
      source: "brain" as const,
      type: RUN_EVENT_TYPES.TOOL_COMPLETED,
      payload: {
        toolId: "tool-1",
        toolName: "search",
        result: { results: [] },
        executionTimeMs: 150,
      },
    });
    expect(completeEvent.type).toBe(RUN_EVENT_TYPES.TOOL_COMPLETED);

    // 4. Run complete
    const runCompleteEvent = parseRunEvent({
      version: 1,
      eventId: "evt-4",
      runId,
      timestamp,
      source: "brain" as const,
      type: RUN_EVENT_TYPES.RUN_COMPLETED,
      payload: {
        status: "complete" as const,
        totalDurationMs: 500,
        toolsUsed: 1,
      },
    });
    expect(runCompleteEvent.type).toBe(RUN_EVENT_TYPES.RUN_COMPLETED);
  });
});
