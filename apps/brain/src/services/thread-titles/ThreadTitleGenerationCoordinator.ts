import type { CoreMessage } from "ai";
import type { ProviderModelTransport } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { AIService } from "../AIService";
import {
  ThreadTitleService,
  type PersistThreadTitleInput,
} from "./ThreadTitleService";
import { createPostgresProviderConfigService } from "../providers/stores/PostgresStoreFactory";
import {
  createOpenRouterThreadTitleGenerator,
  OPENROUTER_FREE_MODEL_ID,
} from "./OpenRouterThreadTitleGenerator";
import {
  buildThreadTitlePreview,
  sanitizePromptForTitle,
} from "./ThreadTitlePreview";
import { buildThreadTitleMessages } from "./ThreadTitlePrompt";

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
}

export interface ThreadTitleGenerator {
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
  }): Promise<{ text: string }>;
}

export interface ThreadTitlePersistence {
  persist(input: PersistThreadTitleInput): Promise<unknown>;
  persistFailure?(
    input: Omit<
      PersistThreadTitleInput,
      "title" | "source" | "titleStatus"
    > & { prompt: string },
  ): Promise<unknown>;
}

interface ThreadTitleGenerationDependencies {
  generator?: ThreadTitleGenerator;
  generatorFactory?: (input: GenerateThreadTitleInput) => ThreadTitleGenerator;
  fallbackGenerator?: ThreadTitleGenerator;
  titleService?: ThreadTitlePersistence;
}

const TITLE_GENERATION_TIMEOUT_MS = 20_000;
const TITLE_ATTEMPTS_PER_ROUTE = 2;

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
      ((input) =>
        new AIService(
          env,
          createPostgresProviderConfigService(
            env,
            input.userId,
            input.workspaceId,
            input.runId,
          ),
        ));
    this.fallbackGenerator =
      dependencies.fallbackGenerator ??
      createOpenRouterThreadTitleGenerator(env);
    this.titleService =
      dependencies.titleService ?? new ThreadTitleService(env);
  }

  schedule(owner: BackgroundTaskOwner, input: GenerateThreadTitleInput): void {
    owner.waitUntil(this.generate(input));
  }

  private async generate(input: GenerateThreadTitleInput): Promise<void> {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      TITLE_GENERATION_TIMEOUT_MS,
    );
    try {
      const messages = buildThreadTitleMessages(input.prompt);
      const selectedGenerator = this.generator ?? this.generatorFactory(input);
      const selectedOutcome = await generateTitleWithRetries(
        selectedGenerator,
        {
          messages,
          providerId: input.providerId,
          model: input.modelId,
          runtimeModelId: input.runtimeModelId,
          providerTransport: input.providerTransport,
          providerEndpoint: input.providerEndpoint,
          signal: abortController.signal,
        },
        input.prompt,
      );
      const fallbackPrompt = sanitizePromptForTitle(input.prompt);
      const fallbackOutcome =
        !selectedOutcome.title && this.fallbackGenerator && fallbackPrompt
          ? await generateTitleWithRetries(this.fallbackGenerator, {
              messages: buildThreadTitleMessages(fallbackPrompt),
              providerId: "openrouter",
              model: OPENROUTER_FREE_MODEL_ID,
              signal: abortController.signal,
            }, input.prompt)
          : undefined;
      const title = selectedOutcome.title ?? fallbackOutcome?.title ?? null;
      if (!title) {
        await this.settleFailure(input);
        const reason = abortController.signal.aborted
          ? "timeout"
          : (fallbackOutcome ?? selectedOutcome).reason;
        console.warn(`[thread-title] generation_failed reason=${reason}`);
        return;
      }
      await this.titleService.persist({
        ...input,
        title,
        source: "generated",
        expectedTitleVersion: input.previewVersion,
      });
    } catch (error) {
      await this.settleFailure(input);
      console.warn(
        `[thread-title] generation_failed reason=${classifyTitleGenerationFailure(
          error,
          abortController.signal.aborted,
        )}`,
      );
    } finally {
      clearTimeout(timeout);
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
    } catch (error) {
      console.warn(
        `[thread-title] failed_settlement_error=${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
  }
}

type ThreadTitleGenerationRequest = Parameters<
  ThreadTitleGenerator["generateText"]
>[0];

async function generateTitleWithRetries(
  generator: ThreadTitleGenerator,
  input: ThreadTitleGenerationRequest,
  prompt: string,
): Promise<{
  title: string | null;
  reason: "invalid_output" | "provider_unavailable";
}> {
  let reason: "invalid_output" | "provider_unavailable" = "invalid_output";
  for (let attempt = 0; attempt < TITLE_ATTEMPTS_PER_ROUTE; attempt += 1) {
    if (input.signal?.aborted) return { title: null, reason };
    try {
      const result = await generator.generateText({
        ...input,
        temperature: 0,
        maxOutputTokens: 32,
      });
      const title = normalizeGeneratedTitle(result.text, prompt);
      if (title) return { title, reason };
    } catch {
      reason = "provider_unavailable";
      // A selected provider can be transiently unavailable. Retry within the
      // shared deadline, then move once to the explicit OpenRouter free route.
    }
  }
  return { title: null, reason };
}

function classifyTitleGenerationFailure(
  error: unknown,
  didTimeOut: boolean,
): "timeout" | "invalid_output" | "provider_unavailable" {
  if (didTimeOut) {
    return "timeout";
  }
  if (
    error instanceof Error &&
    /schema|parse|validation/i.test(error.message)
  ) {
    return "invalid_output";
  }
  return "provider_unavailable";
}

export function normalizeGeneratedTitle(
  value: string,
  prompt?: string,
): string | null {
  const cleaned = value
    .replace(/<think>[\s\S]*?<\/think>\s*/giu, "")
    .replace(/```[\s\S]*?```/gu, "");
  const candidateLines = cleaned
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !/^```/u.test(line));
  for (const candidate of candidateLines) {
    const title = normalizeGeneratedTitleLine(candidate);
    if (title && prompt && isPromptEchoTitle(title, prompt)) {
      continue;
    }
    if (title) return title;
  }
  return null;
}

function isPromptEchoTitle(title: string, prompt: string): boolean {
  const normalizeForComparison = (value: string): string =>
    value
      .toLocaleLowerCase()
      .replace(/[.…!?,:;\-_'"`]/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
  const candidate = normalizeForComparison(title);
  const preview = normalizeForComparison(buildThreadTitlePreview(prompt));
  const fullPrompt = normalizeForComparison(sanitizePromptForTitle(prompt));
  return (
    candidate === preview ||
    (candidate.length >= 20 &&
      (preview.startsWith(candidate) || fullPrompt.startsWith(candidate))) ||
    (candidate.length >= 20 && fullPrompt === candidate)
  );
}

function normalizeGeneratedTitleLine(value: string): string | null {
  const normalized = value
    .replace(/^#{1,6}\s*/u, "")
    .replace(/^(?:[-*+•]|\d+[.)])\s*/u, "")
    .replace(/^title\s*:\s*/iu, "")
    .replace(/^(?:here(?:'s| is)|suggested title)\s*[:\-]\s*/iu, "")
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(/[\p{C}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const title = Array.from(normalized)
    .slice(0, 50)
    .join("")
    .replace(/[\s,;:\-.!?]+$/u, "")
    .trim();
  if (
    /^(?:user(?: input| wants? me)|assistant|system|you are|generate|create)\b/iu.test(
      title,
    ) ||
    /^(?:write|output|produce|return|provide|respond with)\b.{0,32}\btitle\b/iu.test(
      title,
    ) ||
    /^(?:we|i|let(?:'s| us| me)|the task)\b.{0,48}\b(?:generate|create|write|output|produce|return|provide)\b.{0,32}\btitle\b/iu.test(
      title,
    ) ||
    /^(?:input|prompt|instructions?)\s*:/iu.test(title) ||
    /^(?:the )?user(?:'s)?\s+(?:goal|request|task|wants?|is asking)\b/iu.test(
      title,
    ) ||
    /^(?:a |the )?(?:concise |brief )?(?:chat |thread |conversation )?title\s+for\b/iu.test(
      title,
    )
  ) {
    return null;
  }
  return title || null;
}
