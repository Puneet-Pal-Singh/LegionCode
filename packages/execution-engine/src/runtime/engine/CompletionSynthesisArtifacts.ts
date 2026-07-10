import type { CoreMessage } from "ai";
import type { MemoryCoordinator } from "../memory/index.js";
import type { Run } from "../run/index.js";
import type { RunStatus } from "../types.js";

export interface CompletionSynthesisArtifactDependencies {
  memoryCoordinator: MemoryCoordinator;
  persistConversationMessages: (
    runId: string,
    sessionId: string,
    messages: CoreMessage[],
    role: "user" | "assistant",
  ) => Promise<void>;
  safeMemoryOperation: <T>(operation: () => Promise<T>) => Promise<T>;
}

export async function persistSynthesisArtifacts(params: {
  run: Run;
  finalText: string;
  checkpointStatus?: RunStatus;
  deps: CompletionSynthesisArtifactDependencies;
}): Promise<void> {
  const { run, finalText, checkpointStatus = "COMPLETED", deps } = params;

  await deps.safeMemoryOperation(() =>
    deps.memoryCoordinator.extractAndPersist({
      runId: run.id,
      sessionId: run.sessionId,
      source: "synthesis",
      content: finalText,
      phase: "synthesis",
    }),
  );

  await deps.safeMemoryOperation(() =>
    deps.persistConversationMessages(
      run.id,
      run.sessionId,
      [{ role: "assistant", content: finalText }],
      "assistant",
    ),
  );

  await deps.safeMemoryOperation(() =>
    deps.memoryCoordinator.createCheckpoint({
      runId: run.id,
      sequence: 1,
      phase: "synthesis",
      runStatus: checkpointStatus,
      taskStatuses: {},
    }),
  );
}
