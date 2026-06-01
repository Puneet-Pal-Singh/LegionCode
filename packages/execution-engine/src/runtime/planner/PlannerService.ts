// apps/brain/src/core/planner/PlannerService.ts
// Phase 3B: LLM-based planning service that generates execution plans

import type { Run } from "../run/index.js";
import { PlanSchema, type Plan } from "./PlanSchema.js";
import type { ILLMGateway } from "../llm/index.js";
import type { MemoryContext } from "../memory/index.js";

const STRUCTURED_SCHEMA_MISMATCH_SENTINEL =
  "No object generated: response did not match schema";
const PLANNING_TIMEOUT_MS = 12_000;

export interface IPlannerService {
  plan(run: Run, prompt: string, memoryContext?: MemoryContext): Promise<Plan>;
}

export interface PlanContext {
  run: Run;
  prompt: string;
  history?: string;
  memoryContext?: MemoryContext;
}

export class PlannerService implements IPlannerService {
  constructor(private llmGateway: ILLMGateway) {}

  async plan(
    run: Run,
    prompt: string,
    memoryContext?: MemoryContext,
  ): Promise<Plan> {
    const messages = this.buildMessages(run, prompt, memoryContext);

    console.log(`[planner/service] Generating plan for run ${run.id}`);

    const plan = await this.callLLM(run, messages);

    console.log(
      `[planner/service] Generated plan with ${plan.tasks.length} tasks`,
    );

    return plan;
  }

  private buildMessages(
    run: Run,
    prompt: string,
    memoryContext?: MemoryContext,
  ): Array<{
    role: "system" | "user";
    content: string;
  }> {
    return [
      {
        role: "system",
        content: this.getSystemPrompt(),
      },
      {
        role: "user",
        content: this.formatUserPrompt(run, prompt, memoryContext),
      },
    ];
  }

  private getSystemPrompt(): string {
    return `You are a planning assistant. Given a user request, break it down into a structured plan of tasks.

Output a JSON object with this exact structure:
{
  "tasks": [
    {
      "id": "1",
      "type": "analyze|edit|test|review|git|shell",
      "description": "What this task does",
      "dependsOn": [],
      "expectedOutput": "What should be produced",
      "input": { ... task-specific fields ... }
    }
  ],
  "metadata": {
    "estimatedSteps": 3,
    "reasoning": "Brief explanation of the approach"
  }
}

IMPORTANT: Every task MUST have an "input" object with task-specific fields:

ANALYZE: { "path": "relative/file/path.ts" }
  Example: { "type": "analyze", "description": "Read main file", "input": { "path": "src/main.ts" } }

EDIT: { "path": "relative/file/path.ts", "content": "new file content" }
  Example: { "type": "edit", "description": "Update config", "input": { "path": "config.json", "content": "{...}" } }

SHELL: { "command": "npm test" }
  Example: { "type": "shell", "description": "Run tests", "input": { "command": "npm test" } }

TEST: { "command": "npm test src/feature.test.ts" }
  Example: { "type": "test", "description": "Test feature", "input": { "command": "npm test src/feature.test.ts" } }

GIT: { "action": "git_status|git_commit|git_push|git_clone|git_branch_list|etc" }
  Valid git actions: status, diff, stage, unstage, commit, push, git_clone, git_diff, git_commit, git_push, git_pull, git_fetch, git_branch_create, git_branch_switch, git_branch_list, git_stage, git_status, git_config
  Example: { "type": "git", "description": "Commit changes", "input": { "action": "git_commit", "message": "feat: add feature" } }

REVIEW: No input needed (LLM-only task)
  Example: { "type": "review", "description": "Review the changes" }

Rules:
1. Task IDs should be simple strings like "1", "2", "3"
2. Use dependsOn to specify dependencies (e.g., ["1"] means depends on task 1)
3. EVERY non-review task MUST have an "input" object with concrete values (not descriptions)
4. For git tasks, action must be one of the valid git actions
5. Tasks should be atomic and focused
6. Keep tasks under 20 total
7. Never put descriptions or placeholders in the "input" field`;
  }

  private formatUserPrompt(
    run: Run,
    prompt: string,
    memoryContext?: MemoryContext,
  ): string {
    const memorySection =
      memoryContext && memoryContext.relevantEvents.length > 0
        ? `

Previous Context:
${memoryContext.summary || ""}

Key Constraints:
${memoryContext.constraints.map((c) => `- ${c}`).join("\n")}
`
        : "";

    return `Run ID: ${run.id}
Agent Type: ${run.agentType}

User Request:
${prompt}
${memorySection}

Generate a plan to accomplish this request.`;
  }

  private async callLLM(
    run: Run,
    messages: Array<{ role: "system" | "user"; content: string }>,
  ): Promise<Plan> {
    try {
      const result = await this.llmGateway.generateStructured({
        context: {
          runId: run.id,
          sessionId: run.sessionId,
          agentType: run.agentType,
          phase: "planning",
        },
        messages,
        schema: PlanSchema,
        model: run.input.modelId,
        providerId: run.input.providerId,
        runtimeModelId: run.input.runtimeModelId,
        providerTransport: run.input.providerTransport,
        providerEndpoint: run.input.providerEndpoint,
        temperature: 0.2, // Deterministic planning
        timeoutMs: PLANNING_TIMEOUT_MS,
      });
      return result.object as Plan;
    } catch (error) {
      console.error("[planner/service] Failed to generate plan:", error);
      if (isPlanningTimeoutError(error)) {
        throw new PlannerError(
          "Planner request timed out while generating task plan.",
          "PLAN_GENERATION_TIMEOUT",
        );
      }
      if (isPlanningSchemaMismatchError(error)) {
        throw new PlannerError(
          "Planner response did not match required schema.",
          "PLAN_SCHEMA_MISMATCH",
        );
      }
      throw new PlannerError(
        "Failed to generate valid plan from LLM",
        "PLAN_GENERATION_FAILED",
      );
    }
  }
}

export class PlannerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PLAN_SCHEMA_MISMATCH"
      | "PLAN_GENERATION_TIMEOUT"
      | "PLAN_GENERATION_FAILED" = "PLAN_GENERATION_FAILED",
  ) {
    super(`[planner/service] ${message}`);
    this.name = "PlannerError";
  }
}

function isPlanningSchemaMismatchError(error: unknown): boolean {
  return error instanceof Error
    ? error.message.includes(STRUCTURED_SCHEMA_MISMATCH_SENTINEL)
    : false;
}

function isPlanningTimeoutError(error: unknown): boolean {
  return error instanceof Error ? error.name === "LLMTimeoutError" : false;
}
