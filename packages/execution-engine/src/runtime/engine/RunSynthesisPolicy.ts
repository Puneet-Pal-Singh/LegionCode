import {
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../cost/index.js";
import type { ILLMGateway } from "../llm/index.js";
import type { MemoryContext, MemoryCoordinator } from "../memory/index.js";
import type { Run } from "../run/index.js";
import type { TaskRepository } from "../task/index.js";
import { buildGroundedTaskSummary } from "./RunGroundedSummary.js";

interface SynthesizeResultInput {
  run: Run;
  originalPrompt: string;
  memoryContext: MemoryContext | undefined;
  taskRepo: TaskRepository;
  memoryCoordinator: MemoryCoordinator;
  llmGateway: ILLMGateway;
}

export async function synthesizeResultFromTasks({
  run,
  originalPrompt,
  memoryContext,
  taskRepo,
  memoryCoordinator,
  llmGateway,
}: SynthesizeResultInput): Promise<string> {
  const tasks = await taskRepo.getByRun(run.id);
  const groundedSummary = buildGroundedTaskSummary(
    originalPrompt,
    tasks.map((task) => task.toJSON()),
  );

  try {
    const result = await llmGateway.generateText({
      context: {
        runId: run.id,
        sessionId: run.sessionId,
        agentType: run.agentType,
        phase: "synthesis",
      },
      messages: [
        {
          role: "system",
          content:
            "You are a precise runtime summarizer. Use only the provided execution evidence. Never invent completed work.",
        },
        {
          role: "user",
          content: groundedSummary.evidencePrompt,
        },
      ],
      model: run.input.modelId,
      providerId: run.input.providerId,
      runtimeModelId: run.input.runtimeModelId,
      providerTransport: run.input.providerTransport,
      providerEndpoint: run.input.providerEndpoint,
      temperature: 0.7,
    });

    return result.text;
  } catch (error) {
    if (
      error instanceof BudgetExceededError ||
      error instanceof SessionBudgetExceededError
    ) {
      console.error(`[run/engine] Budget exceeded for run ${run.id}`);
      return groundedSummary.fallbackSummary;
    }

    console.error("[run/engine] Synthesis failed:", error);
    return groundedSummary.fallbackSummary;
  }
}
