import { describe, expect, it } from "vitest";
import { getProviderRecoveryAdvice } from "./provider-recovery";

describe("provider recovery advice", () => {
  it("maps missing provider configuration to setup guidance", () => {
    const advice = getProviderRecoveryAdvice("No BYOK provider connected");
    expect(advice.actionLabel).toBe("Open Provider Setup");
    expect(advice.recoveryTarget).toBe("connect");
    expect(advice.message).toContain("missing");
  });

  it("maps selection mismatch to session remediation", () => {
    const advice = getProviderRecoveryAdvice("INVALID_PROVIDER_SELECTION");
    expect(advice.actionLabel).toBe("Review Session Selection");
    expect(advice.remediation).toContain("Choose a connected provider");
  });

  it("maps active-run immutable selection conflicts to wait/stop guidance", () => {
    const advice = getProviderRecoveryAdvice("RUN_MANIFEST_IMMUTABLE");
    expect(advice.actionLabel).toBe("Wait or Stop Current Run");
    expect(advice.remediation).toContain("Wait for the current run to finish");
  });

  it("maps rate limit errors to provider switch guidance", () => {
    const advice = getProviderRecoveryAdvice("RATE_LIMIT exceeded for key");
    expect(advice.actionLabel).toBe("Switch Provider");
    expect(advice.remediation).toContain("Switch to another connected provider");
  });

  it("maps axis quota limit errors to provider switch guidance", () => {
    const advice = getProviderRecoveryAdvice("AXIS_DAILY_LIMIT_EXCEEDED");
    expect(advice.actionLabel).toBe("Switch Provider");
  });

  it("maps planning schema failures to prompt-specific remediation", () => {
    const advice = getProviderRecoveryAdvice("PLAN_SCHEMA_MISMATCH");
    expect(advice.actionLabel).toBe("Retry with Specific Task");
    expect(advice.remediation).toContain("concrete file path or command");
  });

  it("does not route runtime failures to provider setup", () => {
    const advice = getProviderRecoveryAdvice("SANDBOX_UNAVAILABLE");
    expect(advice.actionLabel).toBe("Retry Request");
    expect(advice.recoveryTarget).toBe("general");
    expect(advice.remediation).toContain("changing provider settings");
  });

  it("maps auth scope persistence issues to re-auth guidance", () => {
    const advice = getProviderRecoveryAdvice(
      "Unauthorized: missing or invalid authentication.",
    );
    expect(advice.actionLabel).toBe("Log in again");
    expect(advice.message).toContain("login session");
    expect(advice.recoveryTarget).toBe("auth");
  });

  it("maps normalized expired app-session messages to login recovery", () => {
    const advice = getProviderRecoveryAdvice(
      "Your session is missing or expired. Log in again and retry.",
    );
    expect(advice.actionLabel).toBe("Log in again");
    expect(advice.recoveryTarget).toBe("auth");
  });

  it("returns default advice for unknown errors", () => {
    const advice = getProviderRecoveryAdvice("Unexpected backend error");
    expect(advice.actionLabel).toBe("Retry Request");
    expect(advice.recoveryTarget).toBe("general");
    expect(advice.message).toContain("Unexpected backend error");
  });

  it("does not misroute turn-scope reconstruction to provider setup", () => {
    const advice = getProviderRecoveryAdvice(
      "Turn scope reconstruction failed with HTTP 400",
    );
    expect(advice.recoveryTarget).toBe("general");
    expect(advice.message).toContain("runtime scope");
    expect(advice.remediation).toContain("not evidence of a provider");
  });
});
