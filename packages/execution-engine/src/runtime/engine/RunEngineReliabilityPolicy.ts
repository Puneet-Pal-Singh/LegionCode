import type { Run } from "../run/index.js";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import type { RunRepository } from "../run/index.js";
import type { RunEventRecorder } from "../events/index.js";
import { recordLifecycleStep, recordOrchestrationTerminal } from "./RunMetadataPolicy.js";
import { transitionRunToFailed } from "./RunStatusPolicy.js";
import { redactUserFacingOutput } from "./RunOutputRedactor.js";
import { FinalAssistantMessageService } from "./FinalAssistantMessageService.js";

export async function handleExecutionErrorPolicy(input: {
  runId: string;
  error: unknown;
  runRepo: RunRepository;
  runEventRecorder: RunEventRecorder;
  getRunDurationMs: (run: Run) => number;
}): Promise<void> {
  const errorMessage =
    input.error instanceof Error ? input.error.message : "Unknown execution error";
  try {
    const run = await input.runRepo.getById(input.runId);
    if (run) {
      const finalMessage = new FinalAssistantMessageService().build({
        terminalState: RUN_TERMINAL_STATES.FAILED_RUNTIME,
        outcomeCode: "RUNTIME_FAILED",
        detail: errorMessage,
      });
      const finalSummary = redactUserFacingOutput(finalMessage.content);
      transitionRunToFailed(run, input.runId);
      recordLifecycleStep(run, "TERMINAL", "status=FAILED");
      recordOrchestrationTerminal(run);
      run.metadata.error = errorMessage;
      run.metadata.terminalState = RUN_TERMINAL_STATES.FAILED_RUNTIME;
      run.output = {
        content: finalSummary,
        finalSummary,
      };
      await input.runRepo.update(run);
      await input.runEventRecorder.recordMessageEmitted(
        "assistant",
        finalSummary,
        finalMessage.metadata,
      );
      if (run.status === "FAILED") {
        await input.runEventRecorder.recordRunFailed(
          errorMessage,
          input.getRunDurationMs(run),
          "RUNTIME_FAILED",
        );
      }
    }
  } catch (handlerError) {
    console.error(
      `[run/engine] Failed to handle execution error for run ${input.runId}:`,
      handlerError,
    );
  }

  console.error(`[run/engine] Run ${input.runId} failed:`, errorMessage);
}

export async function safeMemoryOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    console.error("[run/engine] Memory subsystem operation failed:", error);
    throw error;
  }
}
