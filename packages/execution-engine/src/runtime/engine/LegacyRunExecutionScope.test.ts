import { describe, expect, it } from "vitest";
import { requireLegacyRunExecutionScope } from "./LegacyRunExecutionScope.js";

const baseOptions = {
  env: {},
  sessionId: "session-1",
  runId: "run-1",
  correlationId: "correlation-1",
};

describe("requireLegacyRunExecutionScope", () => {
  it("accepts only a server-issued checkout and nested artifact root", () => {
    expect(
      requireLegacyRunExecutionScope({
        ...baseOptions,
        workspaceRoot: "/home/sandbox/checkouts/checkout-1",
        artifactRoot: "/home/sandbox/checkouts/checkout-1/artifacts",
      }),
    ).toEqual({
      workspaceRoot: "/home/sandbox/checkouts/checkout-1",
      artifactRoot: "/home/sandbox/checkouts/checkout-1/artifacts",
    });
  });

  it("rejects missing and legacy run-derived roots", () => {
    expect(() => requireLegacyRunExecutionScope(baseOptions)).toThrow(
      /server-issued task checkout/,
    );
    expect(() =>
      requireLegacyRunExecutionScope({
        ...baseOptions,
        workspaceRoot: "/home/sandbox/runs/run-1",
        artifactRoot: "/home/sandbox/runs/run-1/artifacts",
      }),
    ).toThrow(/server-issued task checkout/);
  });

  it("rejects an artifact root outside the matching checkout", () => {
    expect(() =>
      requireLegacyRunExecutionScope({
        ...baseOptions,
        workspaceRoot: "/home/sandbox/checkouts/checkout-1",
        artifactRoot: "/home/sandbox/checkouts/checkout-2/artifacts",
      }),
    ).toThrow(/scoped beneath/);
  });
});
