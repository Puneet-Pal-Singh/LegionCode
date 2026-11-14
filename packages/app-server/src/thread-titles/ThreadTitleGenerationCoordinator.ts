import { buildThreadTitleInput } from "./ThreadTitleInput.js";
import { buildThreadTitleMessages } from "./ThreadTitlePrompt.js";
import { attemptThreadTitle, classifyTitleProviderError, type TitleAttemptResult } from "./ThreadTitleAttempt.js";
import {
  OPENROUTER_FREE_MODEL_ID,
  type BackgroundTaskOwner,
  type GenerateThreadTitleInput,
  type HostedThreadTitleScope,
  type ThreadTitleGenerationDependencies,
  type ThreadTitleGenerator,
  type ThreadTitlePersistence,
  type ThreadTitleScope,
} from "./ThreadTitleTypes.js";

const TITLE_GENERATION_TIMEOUT_MS = 20_000;

/**
 * Schedules title inference only through the supplied host-owned waitUntil lifecycle.
 * Missing credentials, provider failure, timeout, or invalid output leave the
 * deterministic preview untouched.
 */
export class ThreadTitleGenerationCoordinator<TScope extends ThreadTitleScope = HostedThreadTitleScope> {
  private readonly generator?: ThreadTitleGenerator;
  private readonly generatorFactory: (
    input: GenerateThreadTitleInput<TScope>,
  ) => ThreadTitleGenerator;
  private readonly fallbackGenerator?: ThreadTitleGenerator;
  private readonly titleService: ThreadTitlePersistence<TScope>;

  constructor(dependencies: ThreadTitleGenerationDependencies<TScope>) {
    this.generator = dependencies.generator;
    this.generatorFactory = dependencies.generatorFactory;
    this.fallbackGenerator = dependencies.fallbackGenerator;
    this.titleService = dependencies.titleService;
  }

  schedule(owner: BackgroundTaskOwner, input: GenerateThreadTitleInput<TScope>): void {
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

  private async generate(input: GenerateThreadTitleInput<TScope>): Promise<void> {
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

  private async settleFailure(input: GenerateThreadTitleInput<TScope>): Promise<void> {
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
