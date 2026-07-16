import { describe, expect, it } from "vitest";
import { SecureRuntimeFailureMapper } from "./SecureRuntimeFailureMapper";

const mapper = new SecureRuntimeFailureMapper();

describe("SecureRuntimeFailureMapper", () => {
  it.each([
    ["sandbox_unavailable", "worker_unavailable", 503, true],
    ["timeout", "command_timed_out", 504, true],
    ["cancelled", "command_cancelled", 499, false],
    ["failure", "command_failed", 422, true],
  ] as const)(
    "maps secure %s to the runtime protocol without a provider code",
    (status, code, httpStatus, retryable) => {
      const failure = mapper.toRuntimeFailure(
        {
          taskId: "task-1",
          leaseId: "lease-1",
          correlationId: "secure-correlation-1",
          status,
          retryable,
          error: { code: "CONTAINER_EXITED", message: "container exited" },
        },
        httpStatus,
        {
          plugin: "filesystem",
          action: "read_file",
          runId: "run-1",
          workspaceScope: {
            runAttemptId: "attempt-1",
            workspaceId: "workspace-1",
            root: "/workspace",
          },
        },
      );

      expect(failure).toMatchObject({
        code,
        retryable,
        correlationId: "secure-correlation-1",
        details: {
          httpStatus,
          secureStatus: status,
          secureCode: "CONTAINER_EXITED",
          taskId: "task-1",
          leaseId: "lease-1",
          workspaceScope: { runAttemptId: "attempt-1" },
        },
      });
      expect(failure.code).not.toBe("provider_unavailable");
    },
  );
});
