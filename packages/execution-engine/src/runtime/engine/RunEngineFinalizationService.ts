import type { TranscriptPart } from "@repo/platform-protocol";
import type { Run } from "../run/index.js";
import {
  completeRunWithRecoveredAssistantMessage,
  finalizeRunWithAssistantMessage,
  tryHandlePlanningError,
  type RunCompletionDependencies,
} from "./RunCompletionPolicy.js";
import {
  createRuntimeFinalText,
  type RuntimeFinalText,
} from "./FinalAssistantMessageService.js";

export class RunEngineFinalizationService {
  constructor(
    private readonly getDependencies: () => RunCompletionDependencies,
  ) {}

  completeRunWithAssistantMessage(
    run: Run,
    runtimeFinal: RuntimeFinalText | undefined,
    metadata?: Record<string, unknown>,
    modelParts?: TranscriptPart[],
  ): Promise<Response> {
    return finalizeRunWithAssistantMessage({
      run,
      runtimeFinal,
      modelParts,
      metadata,
      deps: this.getDependencies(),
    });
  }

  completeRunWithRecoveredAssistantMessage(
    run: Run,
    runtimeText: string,
    metadata?: Record<string, unknown>,
    errorMetadata?: string,
    terminalStatus?: "COMPLETED" | "PAUSED",
  ): Promise<Response> {
    return completeRunWithRecoveredAssistantMessage({
      run,
      runtimeFinal: createRuntimeFinalText(runtimeText),
      metadata,
      errorMetadata,
      terminalStatus,
      deps: this.getDependencies(),
    });
  }

  tryHandlePlanningError(
    run: Run,
    runId: string,
    error: unknown,
  ): Promise<Response | null> {
    return tryHandlePlanningError({
      run,
      runId,
      error,
      deps: this.getDependencies(),
    });
  }
}
