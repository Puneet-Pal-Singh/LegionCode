// apps/brain/src/core/agents/ReviewAgent.ts
// Phase 3D: Concrete agent for code review tasks

import type {
  AgentCapability,
  AgentType,
  ExecutionContext,
  SynthesisContext,
  TaskResult,
} from "../types.js";
import type { Task } from "../task/index.js";
import type { Plan, PlanContext } from "../planner/index.js";
import { PlanSchema } from "../planner/index.js";
import { BaseAgent } from "./BaseAgent.js";
import { UnsupportedTaskTypeError } from "./CodingAgent.js";
import { validateSafePath, extractStructuredField } from "./validation.js";
import {
  extractExecutionFailure,
  formatExecutionResult,
  formatTaskOutput,
} from "./ResultFormatter.js";

export class ReviewAgent extends BaseAgent {
  readonly type: AgentType = "review";

  async plan(context: PlanContext): Promise<Plan> {
    console.log(`[agents/review] Generating plan for run ${context.run.id}`);

    const messages = this.buildPlanMessages(context.run, context.prompt);
    const result = await this.llmGateway.generateStructured({
      context: {
        runId: context.run.id,
        sessionId: context.run.sessionId,
        agentType: this.type,
        phase: "planning",
      },
      messages,
      schema: PlanSchema,
      model: context.run.input.modelId,
      providerId: context.run.input.providerId,
      runtimeModelId: context.run.input.runtimeModelId,
      providerTransport: context.run.input.providerTransport,
      providerEndpoint: context.run.input.providerEndpoint,
      temperature: 0.2,
    });

    console.log(
      `[agents/review] Generated plan with ${result.object.tasks.length} tasks`,
    );
    return result.object as Plan;
  }

  async executeTask(
    task: Task,
    context: ExecutionContext,
  ): Promise<TaskResult> {
    console.log(
      `[agents/review] Executing task ${task.id} (${task.type}) in run ${context.runId}`,
    );

    switch (task.type) {
      case "analyze":
        return this.executeAnalyze(task, context);
      case "review":
        return this.executeReview(task, context);
      default:
        throw new UnsupportedTaskTypeError(String(task.type));
    }
  }

  async synthesize(context: SynthesisContext): Promise<string> {
    console.log(`[agents/review] Synthesizing review for run ${context.runId}`);

    const taskSummaries = context.completedTasks
      .map(
        (t) =>
          `- Task ${t.id}: ${t.status} — ${formatTaskOutput(t.output?.content)}`,
      )
      .join("\n");

    const result = await this.llmGateway.generateText({
      context: {
        runId: context.runId,
        sessionId: context.sessionId,
        agentType: this.type,
        phase: "synthesis",
      },
      messages: [
        {
          role: "system",
          content:
            "Summarize the code review findings into a structured report with issues, suggestions, and overall assessment.",
        },
        {
          role: "user",
          content: `Original request: ${context.originalPrompt}\n\nReview findings:\n${taskSummaries}`,
        },
      ],
      model: context.modelId,
      providerId: context.providerId,
      runtimeModelId: context.runtimeModelId,
      providerTransport: context.providerTransport,
      providerEndpoint: context.providerEndpoint,
    });
    return result.text;
  }

  getCapabilities(): AgentCapability[] {
    return [
      { name: "file_read", description: "Read files for review" },
      { name: "code_review", description: "Analyze and review code quality" },
      { name: "suggest_fixes", description: "Suggest code improvements" },
    ];
  }

  protected getPlanSystemPrompt(): string {
    return `You are a code review planner. Break down the review request into analysis tasks.

Output a JSON object with this structure:
{
  "tasks": [
    { "id": "1", "type": "analyze|review", "description": "...", "dependsOn": [], "expectedOutput": "..." }
  ],
  "metadata": { "estimatedSteps": 3, "reasoning": "..." }
}

Rules:
1. Start with "analyze" tasks to read and understand the code
2. Follow with "review" tasks to evaluate quality, patterns, and issues
3. Focus on code quality, security, and best practices
4. Keep tasks atomic and under 20 total`;
  }

  private async executeAnalyze(
    task: Task,
    context: ExecutionContext,
  ): Promise<TaskResult> {
    const path =
      extractStructuredField(task.input, "path") ?? task.input.description;
    validateSafePath(path);

    const result = await this.executionService.execute(
      "filesystem",
      "read_file",
      {
        path,
      },
    );
    const failure = extractExecutionFailure(result);
    if (failure) {
      return {
        taskId: task.id,
        status: "FAILED",
        error: { message: failure },
        completedAt: new Date(),
      };
    }

    const analysisResult = await this.llmGateway.generateText({
      context: {
        runId: context.runId,
        sessionId: context.sessionId,
        taskId: task.id,
        agentType: this.type,
        phase: "task",
      },
      messages: [
        {
          role: "system",
          content:
            "Analyze the following code for quality, patterns, and potential issues.",
        },
        { role: "user", content: formatExecutionResult(result) },
      ],
      model: context.modelId,
      providerId: context.providerId,
      runtimeModelId: context.runtimeModelId,
      providerTransport: context.providerTransport,
      providerEndpoint: context.providerEndpoint,
    });

    return this.buildSuccessResult(task.id, analysisResult.text);
  }

  private async executeReview(
    task: Task,
    context: ExecutionContext,
  ): Promise<TaskResult> {
    const reviewResult = await this.llmGateway.generateText({
      context: {
        runId: context.runId,
        sessionId: context.sessionId,
        taskId: task.id,
        agentType: this.type,
        phase: "task",
      },
      messages: [
        {
          role: "system",
          content:
            "Provide a detailed code review with issues, suggestions, and severity ratings.",
        },
        { role: "user", content: task.input.description },
      ],
      model: context.modelId,
      providerId: context.providerId,
      runtimeModelId: context.runtimeModelId,
      providerTransport: context.providerTransport,
      providerEndpoint: context.providerEndpoint,
    });

    return this.buildSuccessResult(task.id, reviewResult.text);
  }

  private buildSuccessResult(taskId: string, content: string): TaskResult {
    return {
      taskId,
      status: "DONE",
      output: { content },
      completedAt: new Date(),
    };
  }
}
