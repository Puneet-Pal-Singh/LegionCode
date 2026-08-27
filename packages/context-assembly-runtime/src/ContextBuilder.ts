/**
 * ContextBuilder - Main orchestration class
 *
 * Single responsibility: Build context bundle from input
 * No side effects, no network calls, deterministic output
 */
import type {
  ContextBuilder as IContextBuilder,
  ContextBuildInput,
  ContextBundle,
  ContextMessage,
  ToolDescriptor,
  ContextDebugInfo,
  TokenBreakdown,
} from "@legioncode/context-assembly";
import { TokenCounter } from "./TokenCounter.js";
import { TokenBudget } from "./TokenBudget.js";
import { assembleSystem } from "./assemblers/SystemAssembler.js";
import { assembleHistory } from "./assemblers/HistoryAssembler.js";
import { assembleRepo } from "./assemblers/RepoAssembler.js";
import { assembleDiffs } from "./assemblers/DiffAssembler.js";
import { assembleEvents } from "./assemblers/EventAssembler.js";

export class ContextBuilder implements IContextBuilder {
  private tokenCounter: TokenCounter;
  private availableTools: ToolDescriptor[];

  constructor(
    options: { tools?: ToolDescriptor[]; charsPerToken?: number } = {},
  ) {
    this.tokenCounter = new TokenCounter(options.charsPerToken);
    this.availableTools = options.tools ?? [];
  }

  async build(input: ContextBuildInput): Promise<ContextBundle> {
    const budget = new TokenBudget(input.constraints.maxTokens);
    const messages: ContextMessage[] = [];
    const includedFiles: string[] = [];
    const excludedFiles: string[] = [];

    // Reserve buffer if specified
    const bufferTokens = this.calculateBuffer(input);
    budget.forceAllocate(bufferTokens);

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(input);
    const systemTokens = this.tokenCounter.count(systemPrompt);

    if (!budget.allocate(systemTokens)) {
      throw new Error("System prompt exceeds token budget");
    }

    // Add history if available
    if (input.memory) {
      const historyMessages = assembleHistory(input.memory);
      const historyTokens = this.countMessages(historyMessages);

      if (budget.allocate(historyTokens)) {
        messages.push(...historyMessages);
      }
    }

    // Add repo files if available
    if (input.repo) {
      const repoMessage = assembleRepo(input.repo);
      const repoTokens = this.tokenCounter.count(repoMessage.content);

      if (budget.allocate(repoTokens)) {
        messages.push(repoMessage);
        includedFiles.push(
          ...input.repo.files.map((f: { path: string }) => f.path),
        );
      } else {
        excludedFiles.push(
          ...input.repo.files.map((f: { path: string }) => f.path),
        );
      }
    }

    // Add diffs if available
    if (input.repo?.diffs && input.repo.diffs.length > 0) {
      const diffMessage = assembleDiffs(input.repo.diffs);
      const diffTokens = this.tokenCounter.count(diffMessage.content);

      if (budget.allocate(diffTokens)) {
        messages.push(diffMessage);
      }
    }

    // Add recent events if available
    if (input.recentEvents && input.recentEvents.length > 0) {
      const eventMessage = assembleEvents(input.recentEvents);
      const eventTokens = this.tokenCounter.count(eventMessage.content);

      if (budget.allocate(eventTokens)) {
        messages.push(eventMessage);
      }
    }

    // Filter tools by agent capabilities
    const filteredTools = this.filterTools(input);
    const toolsTokens = this.countTools(filteredTools);
    budget.forceAllocate(toolsTokens);

    // Build token breakdown
    const breakdown = this.buildTokenBreakdown(
      systemTokens,
      messages,
      filteredTools,
      budget,
    );

    // Build debug info
    const debug = this.buildDebugInfo(
      includedFiles,
      excludedFiles,
      messages,
      breakdown,
      input.constraints.strategy,
    );

    return {
      system: systemPrompt,
      messages,
      tools: filteredTools,
      tokenEstimate: breakdown.total,
      debug,
    };
  }

  private buildSystemPrompt(input: ContextBuildInput): string {
    return assembleSystem({
      agent: input.agent,
      tools: this.availableTools,
      goal: input.goal.raw,
    });
  }

  private filterTools(input: ContextBuildInput): ToolDescriptor[] {
    return this.availableTools.filter((tool) => {
      if (!tool.requiredCapabilities) {
        return true;
      }
      return tool.requiredCapabilities.every((cap: string) =>
        input.agent.capabilities.includes(
          cap as (typeof input.agent.capabilities)[number],
        ),
      );
    });
  }

  private countMessages(messages: ContextMessage[]): number {
    return messages.reduce(
      (total, msg) => total + this.tokenCounter.count(msg.content),
      0,
    );
  }

  private countTools(tools: ToolDescriptor[]): number {
    return tools.reduce(
      (total, tool) =>
        total +
        this.tokenCounter.count(tool.name) +
        this.tokenCounter.count(tool.description) +
        (tool.schema ? this.tokenCounter.count(JSON.stringify(tool.schema)) : 0),
      0,
    );
  }

  private calculateBuffer(input: ContextBuildInput): number {
    if (!input.constraints.bufferPercentage) {
      return 0;
    }
    return Math.floor(
      (input.constraints.maxTokens * input.constraints.bufferPercentage) / 100,
    );
  }

  private buildTokenBreakdown(
    systemTokens: number,
    messages: ContextMessage[],
    tools: ToolDescriptor[],
    budget: TokenBudget,
  ): TokenBreakdown {
    const messagesTokens = this.countMessages(messages);
    const toolsTokens = this.countTools(tools);
    const OVERHEAD_TOKENS = 50; // Fixed allocation for response buffer
    const allocatedTokens = budget.allocated();
    const total = allocatedTokens + OVERHEAD_TOKENS;

    return {
      system: systemTokens,
      messages: messagesTokens,
      tools: toolsTokens,
      overhead: OVERHEAD_TOKENS,
      total,
      remaining: budget.remaining,
    };
  }

  private buildDebugInfo(
    includedFiles: string[],
    excludedFiles: string[],
    _messages: ContextMessage[],
    breakdown: TokenBreakdown,
    strategy: string,
  ): ContextDebugInfo {
    // Validate strategy at compile time to catch invalid values
    const validStrategies = ["greedy", "balanced", "conservative"] as const;
    const strategyUsed = strategy as "greedy" | "balanced" | "conservative";
    
    if (!validStrategies.includes(strategyUsed)) {
      throw new Error(`Invalid strategy: ${strategy}. Must be one of: ${validStrategies.join(", ")}`);
    }

    return {
      includedFiles,
      excludedFiles,
      droppedMessages: 0,
      summarizationsApplied: 0,
      tokenBreakdown: breakdown,
      strategyUsed,
      assembledAt: Date.now(),
    };
  }
}
