import type { PluginExecutionContext } from "../../interfaces/types";

/** Test-only server-scope fixture for direct plugin contract coverage. */
export function pluginTestExecutionContext(
  payload: unknown,
): PluginExecutionContext {
  const runId = readRunId(payload) ?? "test-run";
  return {
    workspaceScope: {
      runId,
      workspaceId: "workspace-test",
      threadId: "thread-test",
      turnId: "turn-test",
      runAttemptId: "attempt-test",
      root: `/home/sandbox/checkouts/${runId}`,
    },
  };
}

function readRunId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const direct = readSafeRunId(record.runId);
  if (direct) return direct;
  const toolbox = record.__toolbox;
  if (!toolbox || typeof toolbox !== "object") return undefined;
  return readSafeRunId((toolbox as Record<string, unknown>).runId);
}

function readSafeRunId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return undefined;
  }
  return value;
}
