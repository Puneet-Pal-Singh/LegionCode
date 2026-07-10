import { describe, expect, it } from "vitest";
import { createLogger, type LogRecord } from "./logger.js";

describe("structured logger", () => {
  it("emits searchable JSON fields with inherited run context", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      service: "brain",
      environment: "test",
      context: { correlationId: "corr_123", runId: "run_123" },
      sink: { write: (record) => records.push(record) },
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });

    logger.info("run/runtime accepted", { elapsedMs: 12 });

    expect(records).toEqual([
      {
        timestamp: "2026-07-10T00:00:00.000Z",
        level: "info",
        event: "run.runtime_accepted",
        service: "brain",
        environment: "test",
        attributes: {
          correlationId: "corr_123",
          runId: "run_123",
          elapsedMs: 12,
        },
      },
    ]);
  });

  it("redacts secrets, prompts, and tool outputs recursively", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      service: "brain",
      sink: { write: (record) => records.push(record) },
    });

    logger.error("tool.failed", {
      authorization: "Bearer secret-value",
      prompt: "user private request",
      nested: { apiKey: "sk-private-key", output: "private tool output" },
      error: new Error("provider rejected Bearer abcdefghijklmnop"),
    });

    expect(records[0]?.attributes).toMatchObject({
      authorization: "[REDACTED]",
      prompt: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", output: "[REDACTED]" },
      error: { name: "Error", message: "provider rejected [REDACTED]" },
    });
  });

  it("does not throw when diagnostic context is cyclic", () => {
    const records: LogRecord[] = [];
    const context: Record<string, unknown> = {};
    context.self = context;
    const logger = createLogger({
      service: "brain",
      sink: { write: (record) => records.push(record) },
    });

    logger.warn("runtime.context-invalid", context);

    expect(records[0]?.attributes).toEqual({
      self: { self: "[CIRCULAR]" },
    });
  });

  it("groups operational failures by stable code and operation", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      service: "runtime",
      sink: { write: (record) => records.push(record) },
    });
    const error = Object.assign(new Error("database password=private"), {
      code: "CANONICAL_EVENT_PERSIST_FAILED",
      retryable: true,
      status: 503,
    });

    logger.captureException("runtime.event.persist.failed", error, {
      operation: "runtime.event.persist",
      runId: "run_123",
    });

    expect(records[0]).toMatchObject({
      level: "error",
      event: "runtime.event.persist.failed",
      attributes: {
        errorCode: "CANONICAL_EVENT_PERSIST_FAILED",
        retryable: true,
        status: 503,
        operation: "runtime.event.persist",
        runId: "run_123",
        error: { message: "database password=[REDACTED]" },
      },
    });
  });

  it("preserves sanitized cause messages needed to identify the failing boundary", () => {
    const records: LogRecord[] = [];
    const cause = new Error("database password=private");
    const logger = createLogger({
      service: "runtime",
      sink: { write: (record) => records.push(record) },
    });

    logger.captureException("runtime.event.persist.failed", cause);

    expect(records[0]?.attributes.causes).toEqual([
      { name: "Error", message: "database password=[REDACTED]" },
    ]);
  });
});
