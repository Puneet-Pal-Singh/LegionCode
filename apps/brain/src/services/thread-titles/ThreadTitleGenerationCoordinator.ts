import type { CoreMessage } from "ai";
import type {
  BYOKModelCapability,
  ProviderModelTransport,
} from "@repo/shared-types";
import type { Env } from "../../types/ai";
import {
  ThreadTitleService,
  type PersistThreadTitleInput,
} from "./ThreadTitleService";
import {
  createOpenRouterThreadTitleGenerator,
  OPENROUTER_FREE_MODEL_ID,
} from "./OpenRouterThreadTitleGenerator";
import { buildThreadTitleInput } from "./ThreadTitleInput";
import { buildThreadTitleMessages } from "./ThreadTitlePrompt";
import { createSelectedThreadTitleGenerator } from "./SelectedThreadTitleGenerator";
import {
  attemptThreadTitle,
  classifyTitleProviderError,
  type TitleAttemptResult,
} from "./ThreadTitleAttempt";

export interface BackgroundTaskOwner {
  waitUntil(promise: Promise<unknown>): void;
}

export interface GenerateThreadTitleInput extends Omit<
  PersistThreadTitleInput,
  "title" | "source"
> {
  prompt: string;
  previewVersion: number;
  providerId?: string;
  modelId?: string;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
  modelCapabilities?: BYOKModelCapability;
}

export interface ThreadTitleGenerator {
  outputFormat?: "text" | "json";
  generateText(input: {
    messages: CoreMessage[];
    model?: string;
    providerId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    finishReason?: string;
    usage?: { totalTokens: number };
  }>;
}

export interface ThreadTitlePersistence {
  persist(input: PersistThreadTitleInput): Promise<unknown>;
  persistFailure?(
    input: Omit<PersistThreadTitleInput, "title" | "source" | "titleStatus"> & {
      prompt: string;
    },
  ): Promise<unknown>;
}

interface ThreadTitleGenerationDependencies {
  generator?: ThreadTitleGenerator;
  generatorFactory?: (input: GenerateThreadTitleInput) => ThreadTitleGenerator;
  fallbackGenerator?: ThreadTitleGenerator;
  titleService?: ThreadTitlePersistence;
}

const TITLE_GENERATION_TIMEOUT_MS = 20_000;

/**
 * Schedules title inference only through a Worker-owned waitUntil lifecycle.
 * Missing credentials, provider failure, timeout, or invalid output leave the
 * deterministic preview untouched.
 */
export class ThreadTitleGenerationCoordinator {
  private readonly generator?: ThreadTitleGenerator;
  private readonly generatorFactory: (
    input: GenerateThreadTitleInput,
  ) => ThreadTitleGenerator;
  private readonly fallbackGenerator?: ThreadTitleGenerator;
  private readonly titleService: ThreadTitlePersistence;

  constructor(env: Env, dependencies: ThreadTitleGenerationDependencies = {}) {
    this.generator = dependencies.generator;
    this.generatorFactory =
      dependencies.generatorFactory ??
      ((input) => createSelectedThreadTitleGenerator(env, input));
    this.fallbackGenerator =
      dependencies.fallbackGenerator ??
      createOpenRouterThreadTitleGenerator(env);
    this.titleService =
      dependencies.titleService ?? new ThreadTitleService(env);
  }

  schedule(owner: BackgroundTaskOwner, input: GenerateThreadTitleInput): void {
    owner.waitUntil(
      this.generate({
        ...input,
        modelCapabilities: input.modelCapabilities
          ? {
              ...input.modelCapabilities,
              ...(input.modelCapabilities.reasoningEfforts
                ? {
                    reasoningEfforts: [
                      ...input.modelCapabilities.reasoningEfforts,
                    ],
                  }
                : {}),
            }
          : undefined,
      }),
    );
  }

  private async generate(input: GenerateThreadTitleInput): Promise<void> {
    const deadline = Date.now() + TITLE_GENERATION_TIMEOUT_MS;
    // Freeze caller-owned data before the first await, including capability arrays.
    const prompt = buildThreadTitleInput(input.prompt);
    let outcome: TitleAttemptResult = {
      ok: false,
      reason: "route_missing",
      retryable: false,
    };
    try {
      if (input.providerId && input.modelId && prompt) {
        try {
          const generator = this.generator ?? this.generatorFactory(input);
          const messages = buildThreadTitleMessages(
            prompt,
            generator.outputFormat,
          );
          const request = {
            messages,
            providerId: input.providerId,
            model: input.modelId,
            runtimeModelId: input.runtimeModelId,
            providerTransport: input.providerTransport,
            providerEndpoint: input.providerEndpoint,
          };
          outcome = await attemptThreadTitle(generator, request, deadline);
          if (!outcome.ok && outcome.retryable && Date.now() < deadline) {
            outcome = await attemptThreadTitle(
              generator,
              {
                ...request,
                messages: [...messages, ...(outcome.correction ?? [])],
              },
              deadline,
            );
          }
        } catch (error) {
          outcome = { ok: false, ...classifyTitleProviderError(error) };
        }
      }
      if (
        !outcome.ok &&
        this.fallbackGenerator &&
        prompt &&
        Date.now() < deadline
      ) {
        outcome = await attemptThreadTitle(
          this.fallbackGenerator,
          {
            messages: buildThreadTitleMessages(
              prompt,
              this.fallbackGenerator.outputFormat,
            ),
            providerId: "openrouter",
            model: OPENROUTER_FREE_MODEL_ID,
          },
          deadline,
          TITLE_GENERATION_TIMEOUT_MS,
        );
      }
      if (!outcome.ok) {
        await this.settleFailure(input);
        console.warn(
          `[thread-title] generation_failed reason=${outcome.reason}`,
        );
        return;
      }
      await this.titleService.persist({
        ...input,
        title: outcome.title,
        source: "generated",
        expectedTitleVersion: input.previewVersion,
      });
    } catch {
      await this.settleFailure(input);
      console.warn(
        "[thread-title] generation_failed reason=persistence_failed",
      );
    }
  }

  private async settleFailure(input: GenerateThreadTitleInput): Promise<void> {
    if (!this.titleService.persistFailure) {
      return;
    }
    try {
      await this.titleService.persistFailure({
        ...input,
        expectedTitleVersion: input.previewVersion,
      });
    } catch {
      console.warn("[thread-title] failed_settlement_error");
    }
  }
}
