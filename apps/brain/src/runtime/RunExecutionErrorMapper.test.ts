import { describe, expect, it } from "vitest";
import { DomainError } from "../domain/errors";
import { mapRunExecutionErrorToDomain } from "./RunExecutionErrorMapper";
import { ProviderCapabilityError } from "@shadowbox/execution-engine/runtime";
import {
  SecureExecutionContractViolationError,
  SecureExecutionFailureError,
} from "../services/secure-execution/SecureExecutionContract";

describe("RunExecutionErrorMapper", () => {
  it("passes through existing domain errors", () => {
    const error = new DomainError("SOME_CODE", "Domain failure", 422, false);

    const mapped = mapRunExecutionErrorToDomain(error, "corr-1");

    expect(mapped).toBe(error);
  });

  it("maps run manifest mismatch errors to typed immutable-manifest conflict", () => {
    const error = new Error(
      "[run/manifest] Immutable run manifest mismatch. existing={} candidate={}",
    );
    error.name = "RunManifestMismatchError";

    const mapped = mapRunExecutionErrorToDomain(error, "corr-2");

    expect(mapped).toMatchObject({
      code: "RUN_MANIFEST_IMMUTABLE",
      status: 409,
      retryable: false,
      correlationId: "corr-2",
    });
  });

  it("does not map manifest mismatch name without sentinel message", () => {
    const error = new Error("generic mismatch");
    error.name = "RunManifestMismatchError";

    const mapped = mapRunExecutionErrorToDomain(error, "corr-3");

    expect(mapped).toBeNull();
  });

  it("returns null for unrelated errors", () => {
    const mapped = mapRunExecutionErrorToDomain(
      new Error("unknown failure"),
      "corr-4",
    );

    expect(mapped).toBeNull();
  });

  it("maps planning schema mismatch errors to typed validation failure", () => {
    const mapped = mapRunExecutionErrorToDomain(
      new Error("No object generated: response did not match schema."),
      "corr-5",
    );

    expect(mapped).toMatchObject({
      code: "PLAN_SCHEMA_MISMATCH",
      status: 422,
      retryable: false,
      correlationId: "corr-5",
    });
  });

  it("maps planning timeout errors to typed retryable timeout", () => {
    const timeoutError = new Error(
      "[llm/gateway] structured call timed out after 45000ms (phase=planning)",
    );
    timeoutError.name = "LLMTimeoutError";

    const mapped = mapRunExecutionErrorToDomain(timeoutError, "corr-6");

    expect(mapped).toMatchObject({
      code: "PLAN_GENERATION_TIMEOUT",
      status: 504,
      retryable: true,
      correlationId: "corr-6",
    });
  });

  it("maps task execution timeout errors to typed retryable timeout", () => {
    const timeoutError = new Error(
      "[llm/gateway] text call timed out after 60000ms (phase=task)",
    );
    timeoutError.name = "LLMTimeoutError";

    const mapped = mapRunExecutionErrorToDomain(timeoutError, "corr-task");

    expect(mapped).toMatchObject({
      code: "TASK_EXECUTION_TIMEOUT",
      status: 504,
      retryable: true,
      correlationId: "corr-task",
    });
  });

  it("maps provider retry exhaustion to provider unavailable", () => {
    const mapped = mapRunExecutionErrorToDomain(
      new Error("Failed after 3 attempts. Last error: Provider returned error"),
      "corr-7",
    );

    expect(mapped).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      status: 503,
      retryable: true,
      correlationId: "corr-7",
    });
  });

  it("maps provider rate limits to typed 429 error", () => {
    const mapped = mapRunExecutionErrorToDomain(
      new Error("Provider returned status code 429: Too Many Requests"),
      "corr-8",
    );

    expect(mapped).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      retryable: true,
      correlationId: "corr-8",
    });
  });

  it("maps provider auth failures to typed 401 error", () => {
    const mapped = mapRunExecutionErrorToDomain(
      new Error("Provider returned status code 401: invalid api key"),
      "corr-9",
    );

    expect(mapped).toMatchObject({
      code: "AUTH_FAILED",
      status: 401,
      retryable: false,
      correlationId: "corr-9",
    });
  });

  it("maps structured output policy failures to typed runtime errors", () => {
    const mapped = mapRunExecutionErrorToDomain(
      new ProviderCapabilityError(
        "STRUCTURED_OUTPUTS_NOT_SUPPORTED",
        "groq",
        "llama-3.3-70b-versatile",
      ),
      "corr-10",
    );

    expect(mapped).toMatchObject({
      code: "STRUCTURED_OUTPUTS_NOT_SUPPORTED",
      status: 422,
      retryable: false,
      correlationId: "corr-10",
      metadata: {
        lane: undefined,
      },
    });
  });

  it("maps execution lane policy failures with capability-based planning guidance", () => {
    const mapped = mapRunExecutionErrorToDomain(
      new ProviderCapabilityError(
        "EXECUTION_LANE_UNSUPPORTED",
        "axis",
        "z-ai/glm-4.5-air:free",
        "structured_planning_required",
        "Structured planning requires JSON mode or a native structured-output provider transport.",
      ),
      "corr-11",
    );

    expect(mapped).toMatchObject({
      code: "EXECUTION_LANE_UNSUPPORTED",
      status: 422,
      retryable: false,
      correlationId: "corr-11",
      metadata: {
        lane: "structured_planning_required",
      },
    });
    expect(mapped?.message).toBe(
      "The selected provider/model pair cannot satisfy the structured-planning requirements for this request. Choose a model with tool-calling and structured-output support, then retry.",
    );
    expect(mapped?.message).not.toContain("approved");
  });

  it("handles self-referential error causes without infinite loop", () => {
    const cyclicError = new Error("cyclic error") as Error & { cause: Error };
    cyclicError.cause = cyclicError;

    const mapped = mapRunExecutionErrorToDomain(cyclicError, "corr-cyclic");

    expect(mapped).toBeNull();
  });

  it("finds ProviderCapabilityError wrapped in non-cyclic cause chain", () => {
    const innerError = new ProviderCapabilityError(
      "MODEL_NOT_ALLOWED",
      "openai",
      "gpt-4",
    );
    const middleError = new Error("middle error") as Error & {
      cause: Error | ProviderCapabilityError;
    };
    middleError.cause = innerError;
    const outerError = new Error("outer error") as Error & { cause: Error };
    outerError.cause = middleError;

    const mapped = mapRunExecutionErrorToDomain(outerError, "corr-chain");

    expect(mapped).not.toBeNull();
    expect(mapped?.code).toBe("MODEL_NOT_ALLOWED");
    expect(mapped?.metadata).toMatchObject({
      lane: undefined,
      reason: undefined,
    });
  });

  it.each([
    ["sandbox_unavailable", "SANDBOX_UNAVAILABLE", 503, true],
    ["timeout", "EXECUTION_TIMEOUT", 504, true],
    ["cancelled", "EXECUTION_CANCELLED", 499, false],
    ["failure", "SECURE_EXECUTION_FAILED", 422, true],
  ] as const)(
    "maps secure %s without provider relabeling",
    (secureStatus, code, status, retryable) => {
      const mapped = mapRunExecutionErrorToDomain(
        new SecureExecutionFailureError(
          {
            taskId: "task-1",
            leaseId: "lease-1",
            correlationId: "secure-corr-1",
            status: secureStatus,
            retryable,
            error: { code: "CONTAINER_EXITED", message: "container exited" },
          },
          status,
        ),
        "run-corr-1",
      );

      expect(mapped).toMatchObject({
        code,
        status,
        retryable,
        correlationId: "secure-corr-1",
        metadata: {
          taskId: "task-1",
          leaseId: "lease-1",
          secureStatus,
          secureCode: "CONTAINER_EXITED",
        },
      });
      expect(mapped?.code).not.toBe("PROVIDER_UNAVAILABLE");
    },
  );

  it("maps a 2xx secure failure payload as a contract violation", () => {
    const mapped = mapRunExecutionErrorToDomain(
      new SecureExecutionContractViolationError(
        "Secure execution API returned failure with HTTP 200",
        200,
      ),
      "run-corr-2",
    );

    expect(mapped).toMatchObject({
      code: "SECURE_EXECUTION_CONTRACT_VIOLATION",
      status: 502,
      retryable: true,
      correlationId: "run-corr-2",
      metadata: { httpStatus: 200 },
    });
  });
});
