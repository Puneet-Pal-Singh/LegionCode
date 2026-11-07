import { RuntimeKernelError } from "@repo/runtime-kernel";
import type { TurnAdmission } from "@repo/platform-protocol/conversation";
import { codingToolRegistry } from "../tools/CodingToolRegistry.js";
import type { LocalReadOnlyWorkspaceBinding } from "./LocalReadOnlyWorkspaceBinding.js";
import type {
  LocalCapturedExecutionPorts,
  LocalQuiescentWorker,
} from "./LocalTurnExecutionCapability.js";

/** Guards supplied real ports; it never creates capture, approval or lease truth. */
export async function prepareLocalCapturedExecution(
  admission: TurnAdmission,
  binding: LocalReadOnlyWorkspaceBinding,
  supplied: LocalCapturedExecutionPorts,
) {
  if (
    !supplied ||
    admission.run.mode !== "auto_edit" ||
    admission.run.executionCapability !== "repository" ||
    !supplied.worker?.awaitQuiescence ||
    !supplied.gitSnapshots?.captureSnapshot ||
    !supplied.gitSnapshots.getSnapshotDiff ||
    !supplied.turnArtifacts?.putSnapshot ||
    !supplied.turnArtifacts.putTurnDiff ||
    !supplied.mutationLease?.attempt ||
    !supplied.mutationLease.assertCurrent ||
    !supplied.mutationLease.assertSettlementCurrent ||
    !supplied.mutationLease.signal
  ) {
    throw new RuntimeKernelError(
      "tool_policy_denied",
      "Captured execution requires real worker, capture, quiescence and mutation-lease ports",
    );
  }
  const lease = supplied.mutationLease;
  const expected = {
    workspaceId: admission.run.workspaceId,
    threadId: admission.run.threadId,
    runId: admission.run.id,
    turnId: admission.turn.id,
    runAttemptId: admission.runAttemptId,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (lease.attempt[key] !== expected[key])
      throw new RuntimeKernelError(
        "invalid_turn_identity",
        "Mutation lease belongs to a different exact attempt",
      );
  }
  const assertCurrent = async () => {
    binding.signal.throwIfAborted();
    lease.signal.throwIfAborted();
    await binding.assertCurrent();
    await lease.assertCurrent();
    lease.signal.throwIfAborted();
  };
  const assertSettlementCurrent = async () => {
    // Revoke aborts tools, but the host retains this exact writer fence/root until capture finishes.
    await lease.assertSettlementCurrent();
    while (
      !(await supplied.worker.awaitQuiescence({
        turnId: expected.turnId,
        timeoutMs: 500,
      }))
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await lease.assertSettlementCurrent();
    }
    await lease.assertSettlementCurrent();
  };
  const assertWorkspace = (workspace: {
    runId: string;
    filesystemRoot: string;
  }) => {
    if (
      workspace.runId !== expected.runId ||
      workspace.filesystemRoot !== binding.filesystemRoot
    ) {
      throw new RuntimeKernelError(
        "invalid_turn_identity",
        "Capture is outside its configured exact attempt",
      );
    }
  };
  await assertCurrent();
  const tools = selectLocalCapturedTools(supplied);
  const worker: LocalQuiescentWorker = {
    executionCapability: "guarded_mutation",
    awaitQuiescence: (input) =>
      input.turnId === expected.turnId
        ? supplied.worker.awaitQuiescence(input)
        : Promise.resolve(false),
    executeTool: async (input) => {
      await assertCurrent();
      if (
        input.runId !== expected.runId ||
        input.turnId !== expected.turnId ||
        input.runAttemptId !== expected.runAttemptId ||
        input.workspace.workspaceId !== expected.workspaceId ||
        input.workspace.runId !== expected.runId ||
        input.workspace.filesystemRoot !== binding.filesystemRoot ||
        !tools[input.toolCall.toolName]
      ) {
        throw new RuntimeKernelError(
          "invalid_turn_identity",
          "Captured tool is outside its configured exact attempt",
        );
      }
      return supplied.worker.executeTool({
        ...input,
        signal: input.signal
          ? AbortSignal.any([input.signal, lease.signal])
          : lease.signal,
      });
    },
  };
  return {
    worker,
    signal: lease.signal,
    tools,
    turnArtifacts: supplied.turnArtifacts,
    gitSnapshots: {
      captureSnapshot: async (
        input: Parameters<typeof supplied.gitSnapshots.captureSnapshot>[0],
      ) => {
        await assertSettlementCurrent();
        assertWorkspace(input.workspace);
        if (input.snapshotKey !== expected.turnId)
          throw new RuntimeKernelError(
            "invalid_turn_identity",
            "Capture key does not match the admitted turn",
          );
        const result = await supplied.gitSnapshots.captureSnapshot(input);
        assertWorkspace(result);
        await assertSettlementCurrent();
        return result;
      },
      getSnapshotDiff: async (
        input: Parameters<typeof supplied.gitSnapshots.getSnapshotDiff>[0],
      ) => {
        await assertSettlementCurrent();
        assertWorkspace(input.workspace);
        assertWorkspace(input.start);
        assertWorkspace(input.terminal);
        const result = await supplied.gitSnapshots.getSnapshotDiff(input);
        await assertSettlementCurrent();
        return result;
      },
      ...(supplied.gitSnapshots.captureResumeSnapshot
        ? {
            captureResumeSnapshot: async (
              input: Parameters<
                NonNullable<typeof supplied.gitSnapshots.captureResumeSnapshot>
              >[0],
            ) => {
              await assertSettlementCurrent();
              assertWorkspace(input.workspace);
              assertWorkspace(input.terminal);
              const result =
                await supplied.gitSnapshots.captureResumeSnapshot!(input);
              await assertSettlementCurrent();
              return result;
            },
          }
        : {}),
    },
  };
}

/** Select only actual registry definitions whose advertised backend requirements are met. */
export function selectLocalCapturedTools(
  supplied: Pick<
    LocalCapturedExecutionPorts,
    "availableToolIds" | "backendCapabilities" | "tools"
  >,
) {
  return Object.freeze(
    Object.fromEntries(
      supplied.availableToolIds.map((id) => {
        const definition = codingToolRegistry.getDefinition(id);
        const tool = supplied.tools[id];
        if (
          !definition ||
          !tool ||
          tool.parameters !== definition.inputSchema ||
          tool.execute !== undefined ||
          !definition.requiredBackendCapabilities.every((capability) =>
            supplied.backendCapabilities.includes(capability),
          )
        ) {
          throw new RuntimeKernelError(
            "tool_policy_denied",
            "Captured tool is not available from the canonical registry and backend",
          );
        }
        return [id, Object.freeze({ ...tool })];
      }),
    ),
  );
}
