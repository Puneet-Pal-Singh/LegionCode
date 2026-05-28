import type { CoreMessage } from "ai";
import type { BudgetPolicy } from "../cost/BudgetManager.js";
import type { CostEvent, LLMUsage } from "../cost/types.js";
import type { ICostLedger } from "../cost/CostLedger.js";
import type { IPricingResolver } from "../cost/PricingResolver.js";
import type {
  ILLMGateway,
  LLMExecutionLane,
  LLMCallContext,
  LLMRuntimeAIService,
  LLMTextRequest,
  LLMTextResponse,
  LLMStructuredRequest,
  LLMStructuredResponse,
  ProviderCapabilityFlags,
  ProviderCapabilityResolver,
} from "./types.js";

const TOKEN_CHAR_RATIO = 4;
const DEFAULT_IMAGE_INPUT_TOKENS = 1_105;
const DEFAULT_COMPLETION_TOKENS = 500;
const DEFAULT_TEXT_TIMEOUT_MS = 20_000;
const FAST_TASK_TEXT_TIMEOUT_MS = 60_000;
const STANDARD_TASK_TEXT_TIMEOUT_MS = 90_000;
const SLOW_TASK_TEXT_TIMEOUT_MS = 150_000;
const MAX_TASK_TEXT_TIMEOUT_MS = 180_000;
const DEFAULT_STRUCTURED_TIMEOUT_MS = 45_000;

export interface LLMGatewayDependencies {
  aiService: LLMRuntimeAIService;
  budgetPolicy: BudgetPolicy;
  costLedger: ICostLedger;
  pricingResolver: IPricingResolver;
  providerCapabilityResolver?: ProviderCapabilityResolver;
}

export class LLMTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly phase: LLMCallContext["phase"];
  readonly operation: "structured" | "text";

  constructor(input: {
    timeoutMs: number;
    phase: LLMCallContext["phase"];
    operation: "structured" | "text";
  }) {
    const { timeoutMs, phase, operation } = input;
    super(
      `[llm/gateway] ${operation} call timed out after ${timeoutMs}ms (phase=${phase})`,
    );
    this.name = "LLMTimeoutError";
    this.timeoutMs = timeoutMs;
    this.phase = phase;
    this.operation = operation;
  }
}

export class LLMUnusableResponseError extends Error {
  readonly providerId: string;
  readonly modelId: string;
  readonly anomalyCode: string;
  readonly finishReason?: string;
  readonly statusCode?: number;
  readonly usage?: LLMUsage;

  constructor(input: {
    providerId: string;
    modelId: string;
    anomalyCode: string;
    finishReason?: string;
    statusCode?: number;
    usage?: LLMUsage;
  }) {
    const {
      providerId,
      modelId,
      anomalyCode,
      finishReason,
      statusCode,
      usage,
    } = input;
    super(
      `[llm/gateway] Unusable response from ${providerId}:${modelId} (${anomalyCode})`,
    );
    this.name = "LLMUnusableResponseError";
    this.providerId = providerId;
    this.modelId = modelId;
    this.anomalyCode = anomalyCode;
    this.finishReason = finishReason;
    this.statusCode = statusCode;
    this.usage = usage;
  }
}

export class LLMGateway implements ILLMGateway {
  constructor(private deps: LLMGatewayDependencies) {}

  async generateText(req: LLMTextRequest): Promise<LLMTextResponse> {
    this.assertProviderCapabilities(req);
    const estimatedUsage = this.estimateUsage(
      req.messages,
      req.model,
      req.providerId,
    );
    await this.preflight(req, estimatedUsage);
    this.assertPricingAllowed(req.context, estimatedUsage);
    const requestWithIdempotency = this.withIdempotencyKey(
      req,
      req.context.idempotencyKey ??
        this.createIdempotencyKey(req.context, estimatedUsage),
    );

    let result: Awaited<ReturnType<LLMRuntimeAIService["generateText"]>>;
    try {
      result = await this.withTimeout(
        this.deps.aiService.generateText({
          messages: req.messages,
          model: req.model,
          providerId: req.providerId,
          temperature: req.temperature,
          system: req.system,
          tools: req.tools,
        }),
        {
          timeoutMs: this.resolveTextTimeoutMs(req),
          phase: req.context.phase,
          operation: "text",
        },
      );
    } catch (error) {
      const unusableResponse = this.normalizeUnusableResponseError(
        error,
        req,
        estimatedUsage,
      );
      if (unusableResponse) {
        await this.persistCostEvent(
          requestWithIdempotency,
          this.normalizeUsage(unusableResponse.usage ?? estimatedUsage, req.model),
        );
        throw unusableResponse;
      }
      throw error;
    }

    const usage = this.normalizeUsage(result.usage, req.model);
    await this.persistCostEvent(requestWithIdempotency, usage);

    const toolCalls = result.toolCalls?.map((toolCall) => ({
      id: crypto.randomUUID(),
      toolName: toolCall.toolName,
      args: normalizeToolArgs(toolCall.args),
    }));

    return {
      text: result.text,
      usage,
      finishReason: result.finishReason,
      toolCalls,
    };
  }

  async generateStructured<T>(
    req: LLMStructuredRequest<T>,
  ): Promise<LLMStructuredResponse<T>> {
    this.assertProviderCapabilities(req);
    const estimatedUsage = this.estimateUsage(
      req.messages,
      req.model,
      req.providerId,
    );
    await this.preflight(req, estimatedUsage);
    this.assertPricingAllowed(req.context, estimatedUsage);
    const requestWithIdempotency = this.withIdempotencyKey(
      req,
      req.context.idempotencyKey ??
        this.createIdempotencyKey(req.context, estimatedUsage),
    );

    let result: { object: T; usage: LLMUsage };
    try {
      result = await this.withTimeout(
        this.deps.aiService.generateStructured({
          messages: req.messages,
          schema: req.schema,
          model: req.model,
          providerId: req.providerId,
          temperature: req.temperature,
        }),
        {
          timeoutMs: req.timeoutMs ?? DEFAULT_STRUCTURED_TIMEOUT_MS,
          phase: req.context.phase,
          operation: "structured",
        },
      );
    } catch (error) {
      if (error instanceof LLMTimeoutError) {
        try {
          await this.persistCostEvent(requestWithIdempotency, estimatedUsage);
        } catch (persistError) {
          console.error(
            "[llm/gateway] failed to persist fallback structured cost after timeout",
            persistError,
          );
        }
      }
      throw error;
    }

    const usage = this.normalizeUsage(result.usage, req.model);
    await this.persistCostEvent(requestWithIdempotency, usage);

    return {
      object: result.object,
      usage,
    };
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    input: {
      timeoutMs: number;
      phase: LLMCallContext["phase"];
      operation: "structured" | "text";
    },
  ): Promise<T> {
    const { timeoutMs, phase, operation } = input;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new LLMTimeoutError({ timeoutMs, phase, operation }));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async generateStream(
    req: LLMTextRequest,
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertProviderCapabilities(req);
    const estimatedUsage = this.estimateUsage(
      req.messages,
      req.model,
      req.providerId,
    );
    await this.preflight(req, estimatedUsage);
    this.assertPricingAllowed(req.context, estimatedUsage);
    const requestWithIdempotency = this.withIdempotencyKey(
      req,
      req.context.idempotencyKey ??
        this.createIdempotencyKey(req.context, estimatedUsage),
    );
    let didPersistCost = false;
    let persistPromise: Promise<void> | null = null;
    const persistOnce = async (usage: LLMUsage): Promise<void> => {
      if (didPersistCost) {
        return;
      }
      if (!persistPromise) {
        persistPromise = this.persistCostEvent(requestWithIdempotency, usage)
          .then(() => {
            didPersistCost = true;
          })
          .finally(() => {
            persistPromise = null;
          });
      }
      await persistPromise;
    };

    const upstream = await this.deps.aiService.createChatStream({
      messages: req.messages,
      system: req.system,
      tools: req.tools,
      model: req.model,
      providerId: req.providerId,
      temperature: req.temperature,
      onFinish: async (finalResult) => {
        const usage = this.normalizeUsage(finalResult.usage, req.model);
        await persistOnce(usage);
      },
    });

    const reader = upstream.getReader();
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            if (!didPersistCost) {
              await persistOnce(estimatedUsage);
            }
            controller.close();
            return;
          }
          if (chunk.value) {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          if (!didPersistCost) {
            try {
              await persistOnce(estimatedUsage);
            } catch (persistError) {
              console.error(
                "[llm/gateway] failed to persist fallback stream cost after read error",
                persistError,
              );
            }
          }
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        try {
          await reader.cancel(reason);
        } finally {
          if (!didPersistCost) {
            try {
              await persistOnce(estimatedUsage);
            } catch (persistError) {
              console.error(
                "[llm/gateway] failed to persist fallback stream cost after cancellation",
                persistError,
              );
            }
          }
        }
      },
    });
  }

  private async preflight(
    req: LLMTextRequest | LLMStructuredRequest<unknown>,
    usage: LLMUsage,
  ): Promise<void> {
    console.log(
      `[llm/gateway] preflight phase=${req.context.phase} run=${req.context.runId}`,
    );
    await this.deps.budgetPolicy.preflight(req.context, usage);
  }

  private estimateUsage(
    messages: CoreMessage[],
    model?: string,
    providerId?: string,
  ): LLMUsage {
    const charCount = messages.reduce((sum, message) => {
      return sum + this.getMessageLength(message.content);
    }, 0);
    const promptTokens = Math.ceil(charCount / TOKEN_CHAR_RATIO);
    const completionTokens = DEFAULT_COMPLETION_TOKENS;

    return {
      provider: providerId ?? this.deps.aiService.getProvider(),
      model: model ?? this.deps.aiService.getDefaultModel(),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  private getMessageLength(content: CoreMessage["content"]): number {
    if (typeof content === "string") {
      return content.length;
    }
    if (Array.isArray(content)) {
      return content.reduce(
        (sum, part) => sum + getMessagePartLength(part),
        0,
      );
    }
    return getMessagePartLength(content);
  }

  private normalizeUsage(usage: LLMUsage, model?: string): LLMUsage {
    const promptTokens = Math.max(0, usage.promptTokens ?? 0);
    const completionTokens = Math.max(0, usage.completionTokens ?? 0);
    const totalTokens =
      usage.totalTokens && usage.totalTokens > 0
        ? usage.totalTokens
        : promptTokens + completionTokens;

    return {
      ...usage,
      provider: usage.provider || this.deps.aiService.getProvider(),
      model: usage.model || model || this.deps.aiService.getDefaultModel(),
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }

  private normalizeUnusableResponseError(
    error: unknown,
    req: LLMTextRequest,
    fallbackUsage: LLMUsage,
  ): LLMUnusableResponseError | null {
    if (!(error instanceof LLMUnusableResponseError)) {
      return null;
    }

    return new LLMUnusableResponseError({
      providerId: error.providerId || req.providerId || fallbackUsage.provider,
      modelId: error.modelId || req.model || fallbackUsage.model,
      anomalyCode: error.anomalyCode,
      finishReason: error.finishReason,
      statusCode: error.statusCode,
      usage: error.usage ?? fallbackUsage,
    });
  }

  private async persistCostEvent(
    req: LLMTextRequest | LLMStructuredRequest<unknown>,
    usage: LLMUsage,
  ): Promise<void> {
    const resolved = this.deps.pricingResolver.resolve(usage, usage.raw);
    const idempotencyKey =
      req.context.idempotencyKey ??
      this.createIdempotencyKey(req.context, usage);

    const event: CostEvent = {
      eventId: crypto.randomUUID(),
      idempotencyKey,
      runId: req.context.runId,
      sessionId: req.context.sessionId,
      taskId: req.context.taskId,
      agentType: req.context.agentType,
      phase: req.context.phase,
      provider: usage.provider,
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      providerCostUsd: resolved.providerCostUsd,
      calculatedCostUsd: resolved.calculatedCostUsd,
      pricingSource: resolved.pricingSource,
      createdAt: new Date().toISOString(),
    };

    const appended = await this.deps.costLedger.append(event);
    if (appended) {
      await this.deps.budgetPolicy.postCommit(
        req.context,
        resolved.calculatedCostUsd,
      );
    }
    if (resolved.shouldBlock) {
      console.warn(
        `[llm/gateway] unknown pricing persisted post-call for ${usage.provider}:${usage.model}`,
      );
    }
  }

  private assertPricingAllowed(context: LLMCallContext, usage: LLMUsage): void {
    const resolved = this.deps.pricingResolver.resolve(usage, usage.raw);
    if (resolved.shouldBlock) {
      throw new UnknownPricingError(usage.provider, usage.model, context.phase);
    }
  }

  private assertProviderCapabilities(
    req: LLMTextRequest | LLMStructuredRequest<unknown>,
  ): void {
    if (!req.providerId || !req.model) {
      throw new ProviderCapabilityError(
        "INVALID_PROVIDER_SELECTION",
        req.providerId ?? "unset",
        req.model ?? "unset",
      );
    }

    const resolver = this.deps.providerCapabilityResolver;
    if (!resolver) {
      return;
    }

    const capabilities = resolver.getCapabilities(req.providerId);
    if (!capabilities) {
      throw new ProviderCapabilityError(
        "INVALID_PROVIDER_SELECTION",
        req.providerId,
        req.model,
      );
    }

    if (!resolver.isModelAllowed(req.providerId, req.model)) {
      throw new ProviderCapabilityError(
        "MODEL_NOT_ALLOWED",
        req.providerId,
        req.model,
      );
    }

    this.assertToolSupport(req, capabilities);
    this.assertStructuredOutputSupport(req, capabilities);
    this.assertExecutionLaneSupport(req, resolver, req.providerId, req.model);
  }

  private assertToolSupport(
    req: LLMTextRequest | LLMStructuredRequest<unknown>,
    capabilities: ProviderCapabilityFlags,
  ): void {
    if ("tools" in req && req.tools && Object.keys(req.tools).length > 0) {
      if (!capabilities.tools) {
        throw new ProviderCapabilityError(
          "TOOLS_NOT_SUPPORTED",
          req.providerId ?? "unset",
          req.model ?? "unset",
        );
      }
    }
  }

  private assertStructuredOutputSupport(
    req: LLMTextRequest | LLMStructuredRequest<unknown>,
    capabilities: ProviderCapabilityFlags,
  ): void {
    if (!isStructuredRequest(req)) {
      return;
    }
    if (capabilities.structuredOutputs) {
      return;
    }
    throw new ProviderCapabilityError(
      "STRUCTURED_OUTPUTS_NOT_SUPPORTED",
      req.providerId ?? "unset",
      req.model ?? "unset",
    );
  }

  private assertExecutionLaneSupport(
    req: LLMTextRequest | LLMStructuredRequest<unknown>,
    resolver: ProviderCapabilityResolver,
    providerId: string,
    modelId: string,
  ): void {
    const executionLane = resolveExecutionLane(req);
    if (executionLane === "chat_only") {
      return;
    }

    const profile = resolver.getExecutionProfile(providerId, modelId);
    if (!profile) {
      throw new ProviderCapabilityError(
        "EXECUTION_LANE_UNSUPPORTED",
        providerId,
        modelId,
        executionLane,
        "Missing execution profile for selected provider/model.",
      );
    }

    const laneSupport = profile.supportedLanes[executionLane];
    if (laneSupport.supported) {
      return;
    }

    throw new ProviderCapabilityError(
      "EXECUTION_LANE_UNSUPPORTED",
      providerId,
      modelId,
      executionLane,
      laneSupport.reason,
    );
  }

  private withIdempotencyKey<
    T extends LLMTextRequest | LLMStructuredRequest<unknown>,
  >(req: T, idempotencyKey: string): T {
    return {
      ...req,
      context: {
        ...req.context,
        idempotencyKey,
      },
    };
  }

  private createIdempotencyKey(
    context: LLMCallContext,
    usage: LLMUsage,
  ): string {
    return [
      "llm",
      context.runId,
      context.sessionId,
      context.phase,
      context.taskId ?? "none",
      usage.provider,
      usage.model,
      usage.promptTokens.toString(),
      usage.completionTokens.toString(),
      usage.totalTokens.toString(),
    ].join(":");
  }

  private resolveTextTimeoutMs(req: LLMTextRequest): number {
    if (req.context.phase !== "task") {
      return typeof req.timeoutMs === "number"
        ? req.timeoutMs
        : DEFAULT_TEXT_TIMEOUT_MS;
    }

    const requestedTimeoutMs =
      typeof req.timeoutMs === "number"
        ? req.timeoutMs
        : this.resolveTaskTimeoutByLatencyTier(req.providerId, req.model);

    return clampTaskTextTimeoutMs(requestedTimeoutMs);
  }

  private resolveTaskTimeoutByLatencyTier(
    providerId?: string,
    modelId?: string,
  ): number {
    if (!providerId || !modelId) {
      return STANDARD_TASK_TEXT_TIMEOUT_MS;
    }

    const profile = this.deps.providerCapabilityResolver?.getExecutionProfile(
      providerId,
      modelId,
    );
    switch (profile?.latencyTier) {
      case "fast":
        return FAST_TASK_TEXT_TIMEOUT_MS;
      case "slow":
        return SLOW_TASK_TEXT_TIMEOUT_MS;
      case "standard":
      default:
        return STANDARD_TASK_TEXT_TIMEOUT_MS;
    }
  }
}

function clampTaskTextTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return STANDARD_TASK_TEXT_TIMEOUT_MS;
  }

  return Math.min(Math.max(1, timeoutMs), MAX_TASK_TEXT_TIMEOUT_MS);
}

export class UnknownPricingError extends Error {
  constructor(provider: string, model: string, phase: string) {
    super(
      `[llm/gateway] Unknown pricing policy blocked execution for ${provider}:${model} in phase ${phase}`,
    );
    this.name = "UnknownPricingError";
  }
}

export class ProviderCapabilityError extends Error {
  constructor(
    public readonly code:
      | "MODEL_NOT_ALLOWED"
      | "INVALID_PROVIDER_SELECTION"
      | "TOOLS_NOT_SUPPORTED"
      | "STRUCTURED_OUTPUTS_NOT_SUPPORTED"
      | "EXECUTION_LANE_UNSUPPORTED",
    public readonly providerId: string,
    public readonly modelId: string,
    public readonly lane?: LLMExecutionLane,
    public readonly reason?: string,
  ) {
    super(
      buildProviderCapabilityErrorMessage(
        code,
        providerId,
        modelId,
        lane,
        reason,
      ),
    );
    this.name = "ProviderCapabilityError";
  }
}

function resolveExecutionLane(
  req: LLMTextRequest | LLMStructuredRequest<unknown>,
): LLMExecutionLane {
  if (isStructuredRequest(req) && req.context.phase === "planning") {
    return "structured_planning_required";
  }
  if (req.context.phase === "task") {
    return "single_agent_action";
  }
  if ("tools" in req && req.tools && Object.keys(req.tools).length > 0) {
    return "single_agent_action";
  }
  return "chat_only";
}

function isStructuredRequest(
  req: LLMTextRequest | LLMStructuredRequest<unknown>,
): req is LLMStructuredRequest<unknown> {
  return "schema" in req;
}

function buildProviderCapabilityErrorMessage(
  code:
    | "MODEL_NOT_ALLOWED"
    | "INVALID_PROVIDER_SELECTION"
    | "TOOLS_NOT_SUPPORTED"
    | "STRUCTURED_OUTPUTS_NOT_SUPPORTED"
    | "EXECUTION_LANE_UNSUPPORTED",
  providerId: string,
  modelId: string,
  lane?: LLMExecutionLane,
  reason?: string,
): string {
  const laneSegment = lane ? ` lane=${lane}` : "";
  const reasonSegment = reason ? ` reason=${reason}` : "";
  return `[llm/gateway] ${code} for provider=${providerId} model=${modelId}${laneSegment}.${reasonSegment}`.trim();
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return {};
  }
  return args as Record<string, unknown>;
}

function getMessagePartLength(part: unknown): number {
  if (typeof part === "string") {
    return part.length;
  }
  if (!part || typeof part !== "object") {
    return 0;
  }
  const record = part as Record<string, unknown>;
  if (record.type === "image") {
    return DEFAULT_IMAGE_INPUT_TOKENS * TOKEN_CHAR_RATIO;
  }
  if (typeof record.text === "string") {
    return record.text.length;
  }
  if (typeof record.content === "string") {
    return record.content.length;
  }
  return safeJsonLength(record);
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
